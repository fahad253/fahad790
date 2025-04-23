const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const xlsx = require('xlsx');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

let client;
let qrData = '';
let timeoutHandler = null;
let isConnected = false;
let realEstateMessages = [];
let lastCollectionTime = 0;

const SESSION_PATH = path.join(__dirname, '.wwebjs_auth', 'session', 'Default');

// النص المحسّن: تحسين الكلمات المفتاحية وتخزينها في مجموعات أكثر تنظيماً
const keywords = {
  propertyTypes: ['عقار', 'عقارات', 'شقة', 'شقق', 'فيلا', 'فلل', 'ارض', 'أرض', 'عمارة', 'محل', 'مزرعة', 'مخطط', 'استراحة', 'قصر'],
  actions: ['للبيع', 'بيع', 'للشراء', 'شراء', 'للإيجار', 'ايجار', 'استثمار', 'تمليك', 'عرض', 'طلب', 'تسويق'],
  cities: ['الرياض', 'جدة', 'الدمام', 'مكة', 'المدينة', 'القصيم', 'تبوك', 'ينبع', 'حائل', 'أبها', 'نجران', 'جازان', 'الخبر', 'الظهران', 'الأحساء']
};

// تحسين أنماط التعبيرات المنتظمة
const patterns = [
  /مطلوب\s+(فيلا|شقة|أرض|محل|عمارة|استراحة)/i,
  /يوجد\s+(فيلا|شقة|أرض|محل|عمارة|استراحة)/i,
  /(شقة|أرض|فيلا|عمارة|محل|استراحة)\s+لل(بيع|إيجار|استثمار)/i,
  /\d+\s*(متر|م²).*?(\d+)?\s*(ريال|الف|ألف|مليون)/i,
  /عمر العقار.*?\d+/i,
  /سعر المتر.*?\d+/i,
  /اجمالي السعر.*?\d+/i
];

// تحسين دالة فحص الكلمات المفتاحية للعقارات
function containsRealEstateKeyword(message) {
  const normalizedMsg = message.toLowerCase().replace(/[\n\r]/g, ' ');
  
  // البحث عن كلمات نوع العقار
  const hasPropertyType = keywords.propertyTypes.some(kw => normalizedMsg.includes(kw));
  
  // البحث عن كلمات الإجراء (بيع/شراء/إيجار)
  const hasAction = keywords.actions.some(kw => normalizedMsg.includes(kw));
  
  // البحث عن تطابق مع الأنماط المحددة
  const matchesPattern = patterns.some(pattern => pattern.test(normalizedMsg));
  
  // البحث عن اسم مدينة
  const hasCity = keywords.cities.some(city => normalizedMsg.includes(city));
  
  // قاعدة تحسين دقة الاكتشاف: يجب توفر نوع العقار مع إجراء أو نمط محدد
  return (hasPropertyType && (hasAction || hasCity)) || matchesPattern;
}

// تحسين دالة تحليل نوع الرسالة
function analyzeMessageType(message) {
  const normalizedMsg = message.toLowerCase();
  
  if (normalizedMsg.includes('للبيع') || normalizedMsg.includes('بيع') || normalizedMsg.includes('عرض')) return 'بيع';
  if (normalizedMsg.includes('للشراء') || normalizedMsg.includes('شراء') || normalizedMsg.includes('مطلوب')) return 'شراء';
  if (normalizedMsg.includes('ايجار') || normalizedMsg.includes('للإيجار')) return 'إيجار';
  if (normalizedMsg.includes('استثمار')) return 'استثمار';
  return 'غير محدد';
}

// تحسين دالة استخراج المدينة
function extractCity(message) {
  const normalizedMsg = message.toLowerCase();
  for (const city of keywords.cities) {
    if (normalizedMsg.includes(city)) return city;
  }
  return 'غير محددة';
}

// تحسين الكود: إضافة وظيفة استخراج السعر المقدر (إن وجد)
function extractPrice(message) {
  const pricePatterns = [
    /(?:سعر|ب|بسعر|مقابل).*?(\d[\d,]*\s*(?:الف|ألف|مليون|ريال|ر\.س))/i,
    /(\d[\d,]*\s*(?:الف|ألف|مليون|ريال|ر\.س))/i
  ];
  
  for (const pattern of pricePatterns) {
    const match = message.match(pattern);
    if (match && match[1]) return match[1];
  }
  
  return 'غير محدد';
}

// تحسين إدارة جلسة واتساب
function initializeClient() {
  try {
    // تحسين خيارات تهيئة العميل
    client = new Client({
      authStrategy: new LocalAuth({ clientId: 'real-estate-collector' }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      },
      qrMaxRetries: 3
    });

    client.on('qr', (qr) => {
      console.log('📷 QR Received. امسح الكود للاتصال بـ WhatsApp...');
      qrData = qr;
      isConnected = false;
    });

    client.on('ready', async () => {
      console.log('✅ WhatsApp connected. بدأ جمع الرسائل العقارية...');
      isConnected = true;
      
      // بدء جمع الرسائل إذا لم يتم جمعها من قبل
      if (realEstateMessages.length === 0) {
        collectMessages();
      }

      // إعادة تعيين مؤقت إعادة الاتصال
      resetConnectionTimeout();
    });

    client.on('message', async (msg) => {
      // معالجة الرسائل الجديدة فور وصولها
      if (msg.body && containsRealEstateKeyword(msg.body)) {
        try {
          const chat = await msg.getChat();
          const chatName = chat.name || msg.from;
          const sender = msg._data.notifyName || msg.from;
          
          realEstateMessages.push({
            sender: sender,
            chatName: chatName,
            message: msg.body,
            type: analyzeMessageType(msg.body),
            city: extractCity(msg.body),
            price: extractPrice(msg.body),
            time: new Date().toLocaleString()
          });
          
          console.log(`📝 تم إضافة رسالة عقارية جديدة من: ${sender}`);
        } catch (err) {
          console.error('خطأ في معالجة رسالة جديدة:', err.message);
        }
      }
    });

    client.on('auth_failure', () => {
      console.log('❌ فشل في التوثيق، سيتم حذف الجلسة التالفة وإعادة المحاولة...');
      clearCorruptedSession(() => initializeClient());
    });

    client.on('disconnected', (reason) => {
      console.log(`🔌 انقطع الاتصال: ${reason}`);
      isConnected = false;
      qrData = '';
      setTimeout(() => {
        if (!isConnected) initializeClient();
      }, 5000);
    });

    client.initialize().catch(err => {
      console.error('خطأ أثناء التهيئة:', err.message);
      setTimeout(initializeClient, 10000);
    });
    
  } catch (err) {
    if (err.message && err.message.includes('EBUSY')) {
      console.log('🔐 ملف الجلسة مقفل، سيتم محاولة حذفه تلقائيًا...');
      clearCorruptedSession(() => initializeClient());
    } else {
      console.error('❗ خطأ أثناء تشغيل WhatsApp:', err);
      console.log('🚨 حاول إعادة تشغيل البرنامج أو حذف مجلد الجلسة يدويًا.');
      setTimeout(initializeClient, 15000);
    }
  }
}

// وظيفة لإعادة تعيين مؤقت الاتصال
function resetConnectionTimeout() {
  if (timeoutHandler) clearTimeout(timeoutHandler);
  timeoutHandler = setTimeout(() => {
    console.log('⏱️ إعادة تشغيل الجلسة بعد 5 دقائق...');
    if (client) {
      client.destroy().then(() => {
        qrData = '';
        isConnected = false;
        setTimeout(initializeClient, 1000);
      }).catch((err) => {
        console.error('خطأ في تدمير العميل:', err.message);
        setTimeout(initializeClient, 3000);
      });
    } else {
      setTimeout(initializeClient, 1000);
    }
  }, 5 * 60 * 1000); // 5 دقائق
}

// تحسين دالة حذف جلسة تالفة
function clearCorruptedSession(callback) {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      console.log('🧹 تم حذف مجلد الجلسة بنجاح.');
    }
  } catch (e) {
    console.error('❗ تعذر حذف مجلد الجلسة:', e.message);
  }
  setTimeout(callback, 1000);
}

// تحسين دالة جمع الرسائل لتكون أكثر كفاءة
async function collectMessages() {
  if (Date.now() - lastCollectionTime < 60000) {
    console.log('⏱️ تم جمع الرسائل منذ فترة قصيرة، سيتم تخطي العملية');
    return;
  }
  
  lastCollectionTime = Date.now();
  console.log('📥 بدء عملية جمع الرسائل...');
  
  try {
    const chats = await client.getChats();
    console.log(`📚 عدد المحادثات: ${chats.length}`);
    
    const chatPromises = chats.map(async (chat, index) => {
      const chatName = chat.name || chat.id.user;
      console.log(`🗂️ (${index + 1}/${chats.length}) جاري معالجة: ${chatName}`);
      
      try {
        // تحسين: جمع آخر 50 رسالة فقط من كل محادثة
        const messages = await chat.fetchMessages({ limit: 50 });
        const realEstateMessagesInChat = messages.filter(msg => 
          msg.body && containsRealEstateKeyword(msg.body)
        ).map(msg => ({
          sender: msg._data.notifyName || msg._data.from,
          chatName: chatName,
          message: msg.body,
          type: analyzeMessageType(msg.body),
          city: extractCity(msg.body),
          price: extractPrice(msg.body),
          time: new Date(msg.timestamp * 1000).toLocaleString()
        }));
        
        return realEstateMessagesInChat;
      } catch (err) {
        console.log(`⚠️ تعذر تحميل الرسائل من: ${chatName}`);
        return [];
      }
    });
    
    // انتظار جميع العمليات بشكل متوازي
    const results = await Promise.allSettled(chatPromises);
    
    // دمج النتائج
    let newMessages = [];
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        newMessages = newMessages.concat(result.value);
      }
    });
    
    // إضافة الرسائل الجديدة إلى المصفوفة الرئيسية (مع تجنب التكرار)
    const existingIds = new Set(realEstateMessages.map(m => m.sender + m.message));
    const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.sender + m.message));
    
    if (uniqueNewMessages.length > 0) {
      realEstateMessages = [...realEstateMessages, ...uniqueNewMessages];
      console.log(`✅ تم إضافة ${uniqueNewMessages.length} رسالة عقارية جديدة.`);
    } else {
      console.log('ℹ️ لم يتم العثور على رسائل عقارية جديدة.');
    }
    
  } catch (err) {
    console.error('❗ خطأ أثناء جمع الرسائل:', err.message);
  }
}

// تعيين Express
app.use(express.static(path.join(__dirname)));

// تحسين: إضافة ذاكرة تخزين مؤقت لطلبات API
const cacheTimeout = 1000; // ملي ثانية
const cache = {
  qr: { data: null, timestamp: 0 },
  status: { data: null, timestamp: 0 },
  messages: { data: null, timestamp: 0 }
};

// API للحصول على رمز QR
app.get('/qr', async (req, res) => {
  // استخدام التخزين المؤقت إذا كان محدثًا
  if (cache.qr.data && Date.now() - cache.qr.timestamp < cacheTimeout) {
    return res.send(cache.qr.data);
  }
  
  if (!qrData) {
    cache.qr.data = { qr: null };
    cache.qr.timestamp = Date.now();
    return res.send(cache.qr.data);
  }
  
  try {
    const qrImage = await qrcode.toDataURL(qrData);
    cache.qr.data = { qr: qrImage };
    cache.qr.timestamp = Date.now();
    res.send(cache.qr.data);
  } catch (err) {
    res.status(500).send({ qr: null, error: 'QR generation error' });
  }
});

// API للحصول على حالة الاتصال
app.get('/status', (req, res) => {
  // استخدام التخزين المؤقت إذا كان محدثًا
  if (cache.status.data && Date.now() - cache.status.timestamp < cacheTimeout) {
    return res.send(cache.status.data);
  }
  
  cache.status.data = { connected: isConnected };
  cache.status.timestamp = Date.now();
  res.send(cache.status.data);
});

// API للحصول على الرسائل
app.get('/messages', (req, res) => {
  // استخدام التخزين المؤقت إذا كان محدثًا
  if (cache.messages.data && Date.now() - cache.messages.timestamp < cacheTimeout) {
    return res.send(cache.messages.data);
  }
  
  cache.messages.data = realEstateMessages;
  cache.messages.timestamp = Date.now();
  res.send(cache.messages.data);
});

// تحسين تنزيل الملف
app.get('/download', (req, res) => {
  const worksheet = xlsx.utils.json_to_sheet(realEstateMessages);
  
  // تعديل عرض الأعمدة
  const colWidths = [
    { wch: 20 }, // المرسل
    { wch: 20 }, // المجموعة
    { wch: 60 }, // الرسالة
    { wch: 15 }, // النوع
    { wch: 15 }, // المدينة
    { wch: 15 }, // السعر
    { wch: 20 }  // الوقت
  ];
  worksheet['!cols'] = colWidths;
  
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'رسائل العقارات');
  
  const fileName = `رسائل_العقارات_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`;
  const filePath = path.join(__dirname, fileName);
  
  xlsx.writeFile(workbook, filePath);
  res.download(filePath, fileName, (err) => {
    if (!err) {
      // حذف الملف بعد التنزيل
      setTimeout(() => {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('خطأ في حذف الملف المؤقت:', e);
        }
      }, 1000);
    }
  });
});

// إضافة API جديد لإعادة فحص المحادثات يدويًا
app.get('/refresh', async (req, res) => {
  if (!isConnected) {
    return res.status(400).send({ success: false, message: 'لم يتم الاتصال بواتساب' });
  }
  
  collectMessages();
  res.send({ success: true, message: 'تم بدء عملية جمع الرسائل' });
});

// تحسين: إضافة مراقب الصحة للتحقق من حالة الخدمة
app.get('/health', (req, res) => {
  res.send({
    status: 'ok',
    connected: isConnected,
    messagesCount: realEstateMessages.length,
    uptime: process.uptime()
  });
});

// بدء الخادم
app.listen(PORT, () => {
  console.log(`🌐 الخادم يعمل على http://localhost:${PORT}`);
  console.log(`🔗 استخدم http://localhost:${PORT}/health للتحقق من حالة الخدمة`);
});

// تهيئة العميل عند بدء التشغيل
initializeClient();

// قم بمحاولة جمع الرسائل كل 10 دقائق إذا كان العميل متصلاً
setInterval(() => {
  if (isConnected) {
    collectMessages();
  }
}, 10 * 60 * 1000);