# Instinct AI — MVP

مساعد ذكي بواجهة عربية RTL، يعمل على Cloudflare Pages Functions ويتصل بخدمة Gemini من الخادم. مفتاح Gemini لا يُرسل إلى المتصفح ولا يُحفظ في GitHub.

## النشر على Cloudflare Pages

المستودع: `eabdual1lah-sudo/instinct-Ai_2`  
فرع النسخة الحالية: `feat/mvp-initial`

إعدادات مشروع Cloudflare Pages:

- Framework preset: **None**
- Production branch: **feat/mvp-initial**
- Root directory: **/**
- Build command: اتركه فارغًا
- Build output directory: **public**
- Functions directory: **functions** (تُكتشف تلقائيًا من جذر المستودع)

بعد ربط المستودع، انشر المشروع. لا تستخدم مجلد `netlify` أو `api` في إعدادات Cloudflare؛ مسارات Cloudflare موجودة في `functions/api`.

## إضافة مفتاح Gemini بأمان

من Cloudflare Dashboard افتح مشروع Pages ثم **Settings → Variables and Secrets → Production**، وأضف:

**Settings → Variables and Secrets → Add**

أضف متغيرًا من نوع Secret:

- Name: `GEMINI_API_KEY`
- Value: مفتاح Gemini الجديد من Google AI Studio

يستخدم Cloudflare Pages النموذج المستقر `gemini-3.5-flash-lite` من الكود. إذا كان لديك متغير Runtime قديم باسم `GEMINI_MODEL`، فلن يغيّر هذا النموذج. يُقرأ `GEMINI_API_KEY` وقت تشغيل Pages Functions عبر `context.env`، وليس من متغيرات Build أو GitHub Actions. متغيرات Preview منفصلة عن Production؛ إذا اختبرت معاينة فرع فاضبط السر في Preview أيضًا. بعد حفظ Secret، أعد نشر آخر Production deployment. لا تضع المفتاح في GitHub أو داخل ملفات الموقع أو في رسالة محادثة.

## اختبار النشر

افتح:
- `https://YOUR-SITE.pages.dev/api/health`

يجب أن يعرض JSON فيه `"ok":true` و`"apiKeyConfigured":true` بعد ضبط المفتاح.

ثم افتح الصفحة الرئيسية وأرسل رسالة تجريبية. لو ظهر خطأ من Gemini متعلق بالموديل، راجع اسم الموديل المتاح لحسابك واضبط `GEMINI_MODEL` في إعدادات Pages.

إذا بقيت `apiKeyConfigured` بقيمة `false`، فالـ deployment النشط لا يستلم `GEMINI_API_KEY` في Runtime Production. راجع اسم المتغير حرفيًا (`GEMINI_API_KEY`) ونطاق Production، ثم أعد النشر. لا يكشف Health Endpoint قيمة السر.

## التشغيل المحلي

يتطلب Node.js 20 أو أحدث. انسخ `.env.example` إلى `.env`، وضع المفتاح في `GEMINI_API_KEY` داخل الملف المحلي فقط، ثم:

```bash
npm start
```

افتح `http://localhost:3000`.

## ما تتضمنه النسخة الحالية

- واجهة محادثة عربية متجاوبة مع الهاتف والكمبيوتر.
- اتصال خادمي بـ Gemini عبر Cloudflare Pages Function على `/api/chat`.
- فحص صحة الخدمة على `/api/health`.
- سجل محادثة مؤقت في ذاكرة بيئة التشغيل، وليس تخزينًا دائمًا؛ قد يُمسح عند إعادة تشغيل أو توزيع الوظيفة.
- حد لطول الرسالة وحد مبدئي لمعدل الطلبات داخل نسخة الوظيفة.

## حدود مهمة

هذه نسخة MVP أولية وليست بعدُ مساعدًا ذاتي التنفيذ كاملًا. لا يوجد حتى الآن حفظ دائم للمحادثات، أو بحث ويب، أو أدوات تنفذ إجراءات على حساباتك وأجهزتك، أو رفع ملفات وصور. ستُضاف هذه الإمكانات تدريجيًا مع ضوابط أمان وموافقة واضحة.

## الفحص

`npm run check` يفحص صياغة ملفات الخادم والواجهة ووظائف النشر. `npm test` يختبر Cloudflare Pages Functions باستخدام استجابات Gemini وهمية، من دون الحاجة إلى مفتاح حقيقي.
