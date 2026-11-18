# คู่มือระบบตัดต่อวิดีโอด้วย AI (AI Video Editing Pipeline)

คู่มือฉบับนี้เรียบเรียงขึ้นสำหรับโปรเจกต์ **Dead Air Cutter** เพื่อใช้งานร่วมกับ **AI Skills** และ **DaVinci Resolve (เวอร์ชันฟรี)** บนระบบปฏิบัติการ **Windows** โดยเน้นการทำงานแบบ Local-first (ประมวลผลเสียงและเรนเดอร์บนเครื่องเป็นหลัก) เพื่อความเร็ว ความเป็นส่วนตัว และประหยัด Token ของ AI

---

## 1. ภาพรวม Pipeline (5 ขั้นตอน)

```text
[1. Dead Air Cutter] ──▶ [2. AI Rough Cut] ──▶ [3. Motion B-Roll] ──▶ [4. Text Overlay] ──▶ [5. DaVinci Resolve]
  เรียงคลิป / ตัดเงียบ      Whisper ถอดเสียง +     สร้าง B-Roll ตาม      กล่องข้อความเน้นคำ      รวมทุก Track / เกรดสี /
  Export .fcpxml         ตัดพูดผิด/พูดซ้ำ/ฟิลเลอร์   จังหวะคำพูด + CI      ProRes 4444 โปร่งใส     Export วิดีโอขั้นสุดท้าย
```

### จุดเด่นของสถาปัตยกรรมนี้
- **Non-destructive:** ไม่ทำลายไฟล์ต้นฉบับ การตัดต่อแลกเปลี่ยนกันผ่านไฟล์ Timeline (`.fcpxml`)
- **ประหยัด Token:** ใช้ `whisper.cpp` ถอดเสียงเป็นข้อความบนเครื่องก่อน แล้วค่อยให้ AI อ่าน Transcript เพื่อตัดสินใจตัด
- **Human-in-the-loop:** มี Marker สีแดงอธิบายเหตุผลทุกจุดที่ AI ไม่แน่ใจ เพื่อให้คนมาตรวจสอบและปรับแก้ได้ทันทีใน DaVinci Resolve

---

## 2. การเตรียมเครื่องมือบน Windows (ติดตั้งครั้งเดียว)

1. **FFmpeg & FFprobe** (สำหรับแยกเสียง ตรวจจับความเงียบ และรวมเฟรมวิดีโอ):
   ```powershell
   winget install Gyan.FFmpeg
   ```
2. **Python 3.10+** และ **Node.js 20+** (สำหรับรันสคริปต์จัดการ FCPXML และ Playwright):
   - ตรวจสอบด้วย `python --version` และ `node --version`
3. **Whisper.cpp + โมเดลภาษาไทย (`ggml-large-v3.bin`)**:
   - ดาวน์โหลด `whisper-cpp` สำหรับ Windows (หรือ build ด้วย CMake) ให้เรียก `whisper-cli` ได้จาก PATH
   - ดาวน์โหลดโมเดล `ggml-large-v3.bin` (~3 GB) จาก HuggingFace (`ggerganov/whisper.cpp`) มาเก็บไว้ เช่น `C:\models\ggml-large-v3.bin` แล้วตั้ง Environment Variable:
     ```powershell
     mkdir C:\models -Force; curl.exe -L -o C:\models\ggml-large-v3.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
     setx NVE_WHISPER_MODEL "C:\models\ggml-large-v3.bin"
     ```
   *(หลังรัน `setx` ให้ปิดแล้วเปิด Terminal / โปรแกรมใหม่)*
4. **DaVinci Resolve (เวอร์ชันฟรี):**
   - ดาวน์โหลดฟรีจากเว็บ Blackmagic Design (ไม่ต้องใช้เวอร์ชัน Studio) ใช้สำหรับ Export/Import ไฟล์ `.fcpxml`, รวม Track, เกรดสี และ Render `.mp4` จบงาน
4. **Playwright (Chromium)** (สำหรับ Render Motion B-Roll และ Text Overlay):
   ```powershell
   npm install -g playwright
   npx playwright install chromium
   ```

---

## 3. ขั้นตอนที่ 1–2: Rough Cut (Dead Air + พูดผิด/พูดซ้ำ/ฟิลเลอร์)

1. **เรียงคลิปและตัดช่วงเงียบเบื้องต้นใน Dead Air Cutter:**
   - วางไฟล์วิดีโอ (หรือโฟลเดอร์หลายคลิป) ลงใน `media/inbox`
   - เปิดเว็บแอป ตรวจสอบช่วงเงียบสีแดง แล้วกดปุ่ม **`xml`** เพื่อ Export เป็น `.fcpxml`
   - *(หรือเรียงคลิปใน DaVinci Resolve แล้วกด `File > Export > Timeline...` เป็น **FCPXML 1.9**)*
2. **รัน AI Rough Cut:**
   - ระบบจะแยกเสียงด้วย FFmpeg, ตรวจจับช่วงเงียบ/เสียงเบา (RMS-quiet) และถอดเสียงภาษาไทยพร้อม Timestamp ของแต่ละคำด้วย Whisper
   - AI อ่าน Transcript เพื่อตัด:
     - **Retakes & False starts:** ท่อนที่พูดผิดแล้วพูดซ้ำใหม่ (เก็บเฉพาะเทคที่ดีที่สุด)
     - **คำฟิลเลอร์:** เช่น `เอ่อ`, `อ่า`, `อืม`, `ซึ่ง`, `แล้วก็` (เมื่อตัดแล้วประโยคยังสมบูรณ์) โดยตรวจซ้ำด้วย RMS minima ไม่ให้กินเสียงคำถัดไป
     - **ช่วงอัดหน้าจอ:** ตัดช่วงรอโหลด/พิมพ์ที่ไม่พูดให้กระชับกว่าช่วงพูดหน้ากล้อง
   - สร้างไฟล์ `.fcpxml` ใหม่ พร้อม **Marker EDL** อธิบายเหตุผลในจุดที่ควรเช็ก

---

## 4. ขั้นตอนที่ 3: สร้าง Motion B-Roll อัตโนมัติ

ใช้สร้างกราฟิกประกอบคำพูด (Motion Graphic B-Roll) ให้ตรงกับจังหวะคำพูดจากไฟล์ Transcript (`.words.json`):
- **หลักการทำงาน:** AI ออกแบบหน้าเว็บ HTML/CSS/JS ที่เคลื่อนไหวตามจังหวะ (Beats) → ใช้ Playwright จับภาพทีละเฟรม → FFmpeg รวมเป็นไฟล์วิดีโอคุณภาพสูง
- **ความสามารถเพิ่มเติมในชุด Motion Graphics:**
  - `motion-broll`: สร้าง B-Roll คั่นจังหวะหรืออธิบายแนวคิดซับซ้อนให้เห็นภาพ
  - `object-separation`: แยกตัวผู้พูดออกจากพื้นหลังบนเครื่องเพื่อวางซ้อนกราฟิก
  - `sound-effects`: ใส่เสียงประกอบ (SFX) ให้ตรงจังหวะ Transition
  - `explainer-*`: สร้างคลิปอธิบายสินค้า/โปรโมทแบบสั้น 10–90 วินาที

---

## 5. ขั้นตอนที่ 4: สร้าง Text Overlay (กล่องข้อความเน้นคำ)

- **ทำไมต้อง Render เป็น ProRes 4444?**
  - เพราะการ Export/Import ผ่าน FCPXML ใน DaVinci Resolve จะเก็บได้แค่ตัวหนังสือ ฟอนต์ ขนาด และสี แต่ **กรอบกล่อง ขอบ มุมโค้ง เงา และ Animation จะหายหมด**
  - การ Render เป็นไฟล์ **ProRes 4444 (มี Alpha Channel พื้นหลังโปร่งใส)** ทีละข้อความ แล้ววางใน Timeline แยก (`<timeline> text only.fcpxml`) ช่วยให้ได้ดีไซน์สวยครบและยังขยับ/ลบทีละกล่องใน Resolve ได้อิสระ
- **การป้องกันข้อความบังภาพสำคัญ:**
  - ก่อน Render AI จะดึงเฟรมภาพจริงจากวิดีโอมาตรวจตำแหน่งกล้อง (Camera bubble), เมนู, หรือปุ่มที่กำลังสาธิต เพื่อไม่ให้กล่องข้อความทับจุดสำคัญ

---

## 7. ขั้นตอนใช้งานจริงใน DaVinci Resolve (เวอร์ชันฟรี)

1. **Export Timeline ออกไปให้ AI ตัด (กรณีเริ่มจาก Resolve):**
   - เรียงคลิปดิบลงบน **Video Track 1** (หากอัดเสียงไมค์แยก ให้ Auto-Sync ให้เรียบร้อยก่อน)
   - คลิกขวาที่ Timeline ใน Media Pool → `Timelines` → `Export` → เลือก **FCPXML 1.9** (`.fcpxml` ไฟล์เดียว, ไม่ใช้ `.fcpxmld`)
   - *(หรือถ้าใช้ `Dead Air Cutter` เรียงคลิปและตัดเงียบเบื้องต้นแล้ว ให้กดปุ่ม **`xml`** เพื่อรับไฟล์ `.fcpxml` ได้เลย)*
2. **Import ผลลัพธ์จาก `vdo-rough-cut` กลับเข้า Resolve:**
   - ไปที่เมนู `File` → `Import` → `Timeline...` แล้วเลือกไฟล์ `.fcpxml` ที่ตัดเสร็จแล้ว
   - ตรวจเช็กจุดที่มี **Marker สีแดง** (คลิกดูคำอธิบายเหตุผลที่ AI ตัด แล้วดึงขอบคลิปยืดกลับได้ทันทีหากต้องการแก้)
3. **นำ Text Overlay / Motion B-Roll มาวางซ้อน Track บน:**
   - กด `File` → `Import` → `Timeline...` เลือกไฟล์ `<timeline> text only.fcpxml` (จะได้เป็น Timeline แยกอีกอัน)
   - เปิด Timeline ข้อความนั้นขึ้นมา กด `Ctrl+A` → `Ctrl+C` เพื่อคัดลอกคลิปข้อความทั้งหมด แล้วนำไป `Ctrl+V` วางบน **Video Track 2** เหนือ Timeline หลัก (ไฟล์เป็น ProRes 4444 พื้นหลังโปร่งใส จึงซ้อนทับภาพหลักได้ทันที)
4. **Render จบงาน:**
   - ไปที่แท็บ **Deliver** ด้านล่าง เลือก Format `MP4` / Codec `H.264` แล้วกด `Add to Render Queue` → `Render All`

---

## 6. ขั้นตอนที่ 5: การสร้าง Design System (CI) สำหรับงานวิดีโอ

สำหรับงานวิดีโอทั้งหมดในโปรเจกต์นี้ ยึดไฟล์ CI หลักของ **Team Digital** เป็นต้นฉบับเดียว:
- **CI หลัก:** `C:\PARA\2-Areas\teamdigital\marketing\knowledge\TEAMDIGITAL_CI.txt` (TEAM DIGITAL DESIGN LOCK v1.0 — พื้นกรมท่า `#061A2E`/`#07182D`, สีเน้น `#51CBE6`, ฟอนต์ `Kanit`/`Sarabun`, การ์ดมุมโค้ง `20px`)
- **ธีมเสริม (เฉพาะคลิปคอร์ส TikTok):** `C:\PARA\2-Areas\teamdigital\marketing\knowledge\TIKTOK_CI.txt`

> `vdo-text-overlay` ได้ถูกปรับ `assets/caption.html` และ `reference/style.md` ให้ตรงกับ `TEAMDIGITAL_CI.txt` เรียบร้อยแล้ว

### วิธีสร้าง/อัปเดต Design System เพิ่มเติม (กรณีทำแบรนด์ใหม่)
1. **วิธีที่ 1 — เริ่มจากเว็บไซต์ของธุรกิจคุณเอง (เร็วที่สุด):**
   - ให้ AI อ่านเว็บไซต์ของคุณ (หรือแนบภาพหน้าเว็บ + โลโก้) เพื่อสกัด **สีหลัก, สีรอง, ฟอนต์, ระยะห่าง, มุมโค้ง, และน้ำเสียงการสื่อสาร (Tone of Voice)** ออกมาเป็นไฟล์ `design.md`
2. **วิธีที่ 2 — ปรับจากแบรนด์อ้างอิงที่ชอบ:**
   - นำ `design.md` ต้นแบบมาให้ AI ปรับ โดยระบุข้อมูลแบรนด์ของคุณให้ละเอียด (ชื่อช่อง, กลุ่มเป้าหมาย, อารมณ์ภาพ, แนบโลโก้)
3. **ตรวจสอบก่อนใช้งานจริง:**
   - ให้ AI แปลง `design.md` เป็นหน้าเว็บตัวอย่าง (Style Guide Preview) เพื่อเช็กสี ฟอนต์ และปุ่มต่างๆ ให้ตรงใจก่อนนำไปใช้ใน `style.md` ของ Text Overlay และ Motion B-Roll
