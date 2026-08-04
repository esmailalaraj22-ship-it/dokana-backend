# حزمة مراجع قواعد البيانات — مشروع دفتر الدكان

انسخ هذا الفولدر كاملًا كما هو إلى داخل مشروع الـBackend، مثل:

```text
backend/
└── database/
    └── reference/
        └── [محتويات هذا الفولدر]
```

## الملفات الأساسية

- `shop_ledger_postgresql_v1_all_in_one.sql`
  - المخطط المركزي الكامل لـ PostgreSQL.
  - مرجع أولي قبل تحويله إلى Drizzle schemas وmigrations.

- `sqlite_shop_ledger_schema_v1_1.sql`
  - مخطط SQLite المحلي المرجعي المتوافق مع المشروع.
  - للقراءة والتأكد من عقد المزامنة فقط ضمن عمل الـBackend.

- `sqlite_v1_2_settings_patch.sql`
  - تحديث إعدادات SQLite الخاص بالمنطقة الزمنية ويوم العمل.

- `sqlite_postgresql_type_mapping.csv`
  - خريطة المطابقة بين أنواع وحقول SQLite وPostgreSQL.

- `06_runtime_tests.sql`
  - اختبارات تشغيل PostgreSQL الجاهزة للتنفيذ بعد إنشاء القاعدة.

- `static_validation_report.txt`
  - تقرير الفحص الثابت للمخطط.

- `sqlite_v1_1_integration_guide_ar.md`
  - قواعد التوافق والمزامنة بين القاعدتين.

- `POSTGRESQL_README_AR.md`
  - دليل PostgreSQL العربي وتشغيل الحزمة.

- `sqlite_shop_ledger_schema_v1_1_empty.db`
  - قاعدة SQLite فارغة منشأة من المخطط، للفحص فقط.

## تنبيه مهم

هذا الفولدر مرجعي ولا يحتوي أسرارًا أو بيانات عملاء. لا تضع داخله ملف `.env` الحقيقي أو كلمات مرور أو نسخًا من قواعد بيانات الإنتاج.

بعد بدء التنفيذ، تصبح Drizzle schemas وDrizzle migrations هي المصدر التنفيذي لتغييرات PostgreSQL، ويبقى هذا الفولدر مرجعًا ثابتًا للمقارنة والتدقيق.

## التحقق من سلامة الملفات

بعد فك الضغط، افتح الطرفية داخل هذا الفولدر وشغّل:

```bash
sha256sum -c SHA256SUMS.txt
```

يجب أن تظهر كلمة `OK` أمام جميع الملفات.

ملاحظة: هذه الحزمة المرجعية تحتوي ملف PostgreSQL الموحد `shop_ledger_postgresql_v1_all_in_one.sql` بدل ملفات المراحل المنفصلة `01` إلى `05`، لذلك استخدم الملف الموحد عند الإنشاء الأولي، ثم شغّل `06_runtime_tests.sql` منفصلًا للاختبار.
