-- ส่วนปรับท้ายบิลเก็บเป็นจำนวนเงิน ไม่ใช่เปอร์เซ็นต์ (D50/D54 · docs/adr/0004)
--
-- `surcharge_pct numeric(5,2)` เก็บส่วนต่างจริงไม่ลงตัว: ใบเสร็จ 4 ก.ย. 2026 มีรายชิ้น
-- รวม 44000 สตางค์ จ่ายจริง 48700 → 4700/44000 = 10.6818…% ซึ่งถูกปัดเหลือ 10.68
-- แล้ว `round(44000 * 1.1068)` = 48699 ขาดไปหนึ่งสตางค์จากใบเสร็จ
--
-- **ติดลบได้** — ส่วนลดหรือคูปองที่มีคนตั้งใจใส่ · ที่ห้ามคือยอดรวมทั้งบิลไม่เหลือค่า
--
alter table expense
  add column adjustment_satang bigint not null default 0;

-- **ย้ายค่าเก่ามาก่อน drop** — Phase 1 ตั้ง `surcharge_pct = 0` เสมอ แถวที่ไม่เป็นศูนย์
-- จึงไม่ควรมี แต่ถ้ามีแล้ว drop ทิ้งเฉยๆ ยอดจะเพี้ยนแบบเงียบ: `expense_share` รวม
-- ค่าบริการไว้แล้ว ส่วน `total_satang` เป็นยอดก่อนบวก พอ `adjustment_satang` เป็น 0
-- invariant `Σ share = total + adjustment` ก็พังโดยไม่มี constraint ตัวไหนจับได้
--
-- ส่วนต่างที่ถูกต้องคือ `Σ share − total_satang` ตรงๆ ไม่ต้องคำนวณจากเปอร์เซ็นต์ซ้ำ
-- ซึ่งได้ค่าที่ทำให้ invariant กลับมาตรงเป๊ะทุกแถว ไม่ว่าเปอร์เซ็นต์เดิมจะปัดยังไง
update expense e
   set adjustment_satang =
       (select coalesce(sum(s.amount_satang), 0) from expense_share s where s.expense_id = e.id)
       - e.total_satang
 where e.surcharge_pct <> 0;

alter table expense
  add constraint expense_total_after_adjustment_check
  check (total_satang + adjustment_satang > 0);

alter table expense drop column surcharge_pct;

-- invariant (มีเทสต์คุมใน contract.db.test.ts):
--   Σ amount_satang = total_satang + adjustment_satang
-- ไม่มีการปัดอีกแล้ว — บวก integer เข้ากับ integer
comment on column expense.adjustment_satang is
  'ส่วนปรับท้ายบิลเป็นสตางค์ ติดลบได้เมื่อเป็นส่วนลด — Σ expense_share.amount_satang = total_satang + adjustment_satang';
