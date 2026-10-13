# ربط الامتحان بـ Firebase (ليعمل من أي جهاز)

## 1) إنشاء المشروع
1. ادخل https://console.firebase.google.com ← **Add project** وأنشئ مشروعًا.
2. من القائمة **Build ← Firestore Database** اضغط **Create database** واختر أقرب منطقة، ثم ابدأ بـ **Test mode**.
3. من تبويب **Rules** الصق محتوى ملف `firestore.rules` واضغط **Publish**.
   (وضع Test mode ينتهي بعد 30 يومًا، لذلك يجب نشر القواعد هذه.)

## 2) الحصول على إعدادات الموقع
1. **Project settings** (أيقونة الترس) ← تبويب **General**.
2. في **Your apps** اضغط أيقونة الويب `</>` وسجّل تطبيقًا (لا حاجة لتفعيل Hosting).
3. انسخ القيم داخل `firebaseConfig`.

## 3) وضعها في الموقع
افتح `config.js` وضع القيم داخل `window.FIREBASE_CONFIG`.

## 4) الرفع
ارفع كل الملفات إلى GitHub Pages أو أي استضافة، وأنشئ الامتحان **من جديد** (الامتحانات القديمة موجودة في متصفح الجهاز القديم فقط)، ثم افتح الموقع من أي جهاز.

## ملاحظات
- إن كان موقعك على نطاق مخصص أو GitHub Pages فلا حاجة لإضافته في Authorized domains لأن النظام لا يستخدم Firebase Auth.
- قواعد Firestore مفتوحة (قراءة/كتابة للجميع) لأن النظام لا يستخدم تسجيل دخول Firebase، أي أن طالبًا متمرسًا يمكنه نظريًا رؤية مفاتيح الإجابات. مناسب للاستخدام التعليمي العادي، وللامتحانات الحساسة يلزم خادم وسيط.
- كلمة مرور الأستاذ وجلسته ما زالتا محليتين، وتغيير كلمة المرور لا ينتقل بين الأجهزة.
- بديل: Supabase (ملف `setup.sql`) إن فضّلته.

---
## إن كنت تستخدم Realtime Database (وليس Firestore)
1. من **Realtime Database ← Rules** الصق محتوى `database.rules.json` واضغط Publish.
2. من تبويب **Data** انسخ رابط القاعدة أعلى الصفحة (يبدو مثل `https://xxxx-default-rtdb.firebaseio.com`) وضعه في `databaseURL` داخل `config.js`.
3. عند وضع `databaseURL` يستخدم النظام Realtime Database تلقائيًا.

---
## حماية حساب الأستاذ (مهم)
1. في Firebase: **Build ← Authentication ← Get started ← Sign-in method** فعّل **Email/Password** (وAnonymous لجلسات الطلاب).
2. تبويب **Users ← Add user** وأدخل بريدًا وكلمة مرور قوية لكل حساب أستاذ تريد إنشاءه (يمكن إنشاء أكثر من حساب).
3. **Project settings ← General** انسخ **Web API Key** وضعه في `apiKey` داخل `config.js`.
4. ألصق محتوى `database.rules.json` في **Realtime Database ← Rules** واضغط Publish.
5. من تبويب **Data** أنشئ عقدة `teacherUids`، وتحتها أضف مفتاحًا بقيمة **User UID** لكل حساب أستاذ أنشأته (من عمود UID في صفحة Users) والقيمة `true`. أي حساب UID غير مُدرج هنا لن يملك أي صلاحية حتى لو سجّل دخول بنجاح — هذه العقدة قابلة للتعديل يدويًا من Console فقط، ولا يستطيع أي كود في الموقع الكتابة فيها.
6. **عطّل التسجيل الذاتي بالبريد** حتى لا يُنشئ أحد حساب بريد جديد: Authentication ← Settings ← User actions ← أزل «Enable create (sign-up)» (هذا لا يمنع التسجيل المجهول للطلاب، وهو مطلوب ومنفصل).
7. غيّر كلمة المرور القديمة المنشورة سابقًا في أي مكان (كانت ظاهرة في الكود وفي README).

ما الذي تحمله القواعد: `answerKeys`/`exams`/`questions` (الخاصة) قراءةً وكتابةً لمن UID له موجود في `teacherUids` فقط. الطلاب يقرؤون نسخة عامة من الامتحانات/الأسئلة (`examsPublic`/`questionsPublic`) لا تحتوي إلا على ما نشره الأستاذ فعليًا، ويكتبون محاولاتهم وإجاباتهم الخاصة فقط. راجع `SECURITY.md` لتفاصيل إضافية وحدود معروفة متبقية.
