insert into public.faq_items (title, body, sort_order)
select 'الشاشة تطفئ', 'افصل كهرباء الجهاز والشاشة ثلاثين ثانية ثم شغّلهما، وتأكد أن كابل الشاشة موصل. إذا استمر الإطفاء اكتب رقم الجهاز وأكمل البلاغ.', coalesce((select max(sort_order) + 1 from public.faq_items), 1)
where not exists (select 1 from public.faq_items where title = 'الشاشة تطفئ');

insert into public.faq_items (title, body, sort_order)
select 'البرنامج لا يفتح', 'أغلق البرنامج ثم افتحه من جديد. إذا ظهرت رسالة خطأ انسخها في وصف البلاغ واختر نوع العطل برامج.', coalesce((select max(sort_order) + 1 from public.faq_items), 1)
where not exists (select 1 from public.faq_items where title = 'البرنامج لا يفتح');
