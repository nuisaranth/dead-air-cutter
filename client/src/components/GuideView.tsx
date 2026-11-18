import { useState } from 'react';

type TabId = 'overview' | 'rough-cut' | 'broll' | 'text-overlay' | 'davinci' | 'design-system';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'ภาพรวม & ติดตั้ง (Windows)' },
  { id: 'rough-cut', label: '1. AI Rough Cut' },
  { id: 'broll', label: '2. Motion B-Roll' },
  { id: 'text-overlay', label: '3. Text Overlay' },
  { id: 'davinci', label: '4. DaVinci Resolve (ฟรี)' },
  { id: 'design-system', label: '5. Design System (CI)' },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="guide-code-wrap">
      <pre className="guide-code">
        <code>{code}</code>
      </pre>
      <button type="button" className="guide-copy" onClick={onCopy}>
        {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
      </button>
    </div>
  );
}

export function GuideView({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<TabId>('overview');

  return (
    <div className="guide">
      <header className="guide-header">
        <div>
          <h2>คู่มือ AI Video Editing Pipeline</h2>
          <p className="guide-sub">
            แนวทางใช้งาน Dead Air Cutter ร่วมกับ AI Skills และ DaVinci Resolve (อัปเดตสำหรับ Windows)
          </p>
        </div>
        <button type="button" className="guide-back" onClick={onBack}>
          ← กลับหน้าตัดต่อ
        </button>
      </header>

      <nav className="guide-tabs" aria-label="หมวดหมู่คู่มือ">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`guide-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="guide-body">
        {tab === 'overview' && (
          <section className="guide-section">
            <h3>ภาพรวมการทำงาน 5 ขั้นตอน (Local-First Pipeline)</h3>
            <p>
              ระบบนี้ออกแบบให้ทำงานบนเครื่องของคุณเป็นหลัก (Local-first) โดยใช้ไฟล์ <code>.fcpxml</code>{' '}
              เป็นตัวกลางแลกเปลี่ยน Timeline กับ DaVinci Resolve เวอร์ชันฟรี ทำให้ไม่ต้อง Render ซ้ำไปมาและประหยัด Token ของ AI
            </p>
            <div className="guide-flow">
              <div className="guide-step">
                <strong>1. Dead Air Cutter</strong>
                <span>เรียงคลิป / ตัดช่วงเงียบเบื้องต้น / Export .fcpxml</span>
              </div>
              <span className="guide-arrow">→</span>
              <div className="guide-step">
                <strong>2. AI Rough Cut</strong>
                <span>Whisper ถอดเสียงไทย + ตัดพูดผิด/ซ้ำ/ฟิลเลอร์</span>
              </div>
              <span className="guide-arrow">→</span>
              <div className="guide-step">
                <strong>3. Motion B-Roll</strong>
                <span>สร้าง B-Roll ตามจังหวะคำพูดและ CI</span>
              </div>
              <span className="guide-arrow">→</span>
              <div className="guide-step">
                <strong>4. Text Overlay</strong>
                <span>กล่องข้อความเน้นคำ ProRes 4444 โปร่งใส</span>
              </div>
              <span className="guide-arrow">→</span>
              <div className="guide-step">
                <strong>5. DaVinci Resolve</strong>
                <span>รวมทุก Track / เกรดสี / Export จบงาน</span>
              </div>
            </div>

            <h3>การเตรียมเครื่องมือบน Windows (ติดตั้งครั้งเดียว)</h3>
            <ol className="guide-list">
              <li>
                <strong>FFmpeg &amp; FFprobe</strong> (แยกเสียง, ตรวจจับความเงียบ, รวมเฟรมวิดีโอ):
                <CodeBlock code="winget install Gyan.FFmpeg" />
              </li>
              <li>
                <strong>Whisper.cpp + โมเดลภาษาไทย (ggml-large-v3.bin)</strong> สำหรับถอดเสียงบนเครื่อง:
                <CodeBlock
                  code={
                    'mkdir C:\\models -Force; curl.exe -L -o C:\\models\\ggml-large-v3.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin\nsetx NVE_WHISPER_MODEL "C:\\models\\ggml-large-v3.bin"'
                  }
                />
              </li>
              <li>
                <strong>DaVinci Resolve (เวอร์ชันฟรี)</strong> สำหรับ Export/Import <code>.fcpxml</code>, รวม Track และ Render จบงาน
              </li>
              <li>
                <strong>Playwright (Chromium)</strong> สำหรับ Render Motion B-Roll และ Text Overlay ทีละเฟรม:
                <CodeBlock code={'npm install -g playwright\nnpx playwright install chromium'} />
              </li>
            </ol>

            <div className="guide-links">
              <span>เอกสารฉบับเต็มในโปรเจกต์: <code>docs/ai-video-pipeline.md</code></span>
            </div>
          </section>
        )}

        {tab === 'rough-cut' && (
          <section className="guide-section">
            <h3>1. AI Rough Cut (ตัดช่วงเงียบ พูดผิด พูดซ้ำ คำฟุ่มเฟือย)</h3>
            <p>
              ใช้ร่วมกับผลลัพธ์จากปุ่ม <strong>xml</strong> ใน Dead Air Cutter (หรือ Export FCPXML 1.9 จาก DaVinci Resolve)
              เพื่อให้ AI วิเคราะห์คำพูดจาก Transcript และช่วยตัดท่อนที่ไม่จำเป็นออก
            </p>
            <h4>สิ่งที่ระบบช่วยตัดให้อัตโนมัติ</h4>
            <ul className="guide-list">
              <li><strong>Dead Air &amp; RMS-quiet:</strong> ตัดช่วงเงียบและเสียงเบาที่ไม่มีคำพูด (ช่วงอัดหน้าจอจะตัดกระชับกว่าช่วงพูดหน้ากล้อง)</li>
              <li><strong>Retakes &amp; False starts:</strong> ท่อนที่พูดผิดแล้วพูดซ้ำใหม่ จะเก็บเฉพาะเทคที่สมบูรณ์ที่สุดไว้</li>
              <li><strong>คำฟิลเลอร์ภาษาไทย:</strong> เช่น <code>เอ่อ</code>, <code>อ่า</code>, <code>อืม</code>, <code>ซึ่ง</code>, <code>แล้วก็</code> (ตรวจเช็กขอบคำด้วย RMS minima เพื่อไม่ให้กินเสียงคำถัดไป)</li>
              <li><strong>Marker อธิบายเหตุผล:</strong> จุดที่ AI ไม่แน่ใจจะสร้าง Marker สีแดงพร้อมเหตุผลกำกับไว้ให้คนตรวจสอบต่อได้ง่าย</li>
            </ul>
            <h4>ไฟล์ผลลัพธ์ที่ได้</h4>
            <p>
              จะได้ไฟล์ Timeline ใหม่ (<code>.fcpxml</code>) + <code>Marker EDL</code> และไฟล์ถอดเสียง{' '}
              <code>.nve/&lt;clip&gt;.words.json</code> ซึ่งนำไปใช้ต่อในขั้น Motion B-Roll และ Text Overlay ได้ทันที
            </p>
            <div className="guide-links">
              <a href="https://github.com/ManageWithNoobItGuy/noobit-vdo-editor" target="_blank" rel="noreferrer">
                อ้างอิงต้นฉบับ: noobit-vdo-editor (GitHub) ↗
              </a>
            </div>
          </section>
        )}

        {tab === 'broll' && (
          <section className="guide-section">
            <h3>2. Motion B-Roll &amp; Motion Graphics</h3>
            <p>
              สร้างคลิป Motion Graphic ประกอบคำพูดให้ตรงจังหวะเสียง โดยใช้ HTML/CSS/JS วาด Animation แล้ว Render
              ผ่าน Playwright + FFmpeg ออกมาเป็นไฟล์วิดีโอ
            </p>
            <h4>สกิลในชุด Motion Graphics</h4>
            <ul className="guide-list">
              <li><strong>motion-broll:</strong> อ่าน Transcript แล้วสร้างกราฟิก B-Roll คั่นจังหวะหรืออธิบายแนวคิดที่ซับซ้อน</li>
              <li><strong>object-separation:</strong> แยกตัวผู้พูดออกจากพื้นหลังบนเครื่องเพื่อวางซ้อนกราฟิก</li>
              <li><strong>sound-effects:</strong> ใส่เสียงเอฟเฟกต์ (SFX) ให้ตรงจังหวะ Transition</li>
              <li><strong>explainer-default / engaging / high-energy:</strong> สร้างคลิป Demo หรือ Teaser โปรโมทสั้น 10–90 วินาที</li>
            </ul>
            <h4>คำสั่งติดตั้งชุด Skill (อ้างอิง)</h4>
            <CodeBlock code="npx skills add Barty-Bart/motion-graphics" />
            <div className="guide-links">
              <a href="https://github.com/Barty-Bart/motion-graphics" target="_blank" rel="noreferrer">
                อ้างอิงต้นฉบับ: Barty-Bart/motion-graphics (GitHub) ↗
              </a>
            </div>
          </section>
        )}

        {tab === 'text-overlay' && (
          <section className="guide-section">
            <h3>3. Text Overlay (กล่องข้อความเน้นคำ ProRes 4444)</h3>
            <p>
              เพิ่มกล่องข้อความสรุปประเด็นสำคัญบนหน้าจอ โดยสร้างเป็น <strong>Timeline แยกต่างหาก</strong> (<code>&lt;timeline&gt; text only.fcpxml</code>) เพื่อไม่ให้กระทบกับ Timeline หลักของคุณ
            </p>
            <h4>ทำไมต้อง Render เป็น ProRes 4444 แทน FCPXML Text?</h4>
            <p>
              การ Export/Import FCPXML ใน DaVinci Resolve จะเก็บได้แค่ตัวอักษร ฟอนต์ และสี แต่กล่องพื้นหลัง ขอบ มุมโค้ง เงา และ Animation จะหายหมด
              การ Render เป็นไฟล์วิดีโอ <strong>ProRes 4444 (มี Alpha พื้นหลังโปร่งใส)</strong> ช่วยให้ได้งานตรงตาม Design System เป๊ะๆ และยังลบหรือขยับทีละกล่องใน Resolve ได้อิสระ
            </p>
            <h4>จุดเด่นของ Pipeline นี้</h4>
            <ul className="guide-list">
              <li>ดึงเวลาจาก <code>.nve/&lt;stem&gt;.words.json</code> ให้ข้อความขึ้นตรงคำพูดพอดี</li>
              <li>ดึงภาพหน้าจอจริงมาตรวจสอบก่อน Render เพื่อไม่ให้กล่องข้อความบังวงกลมกล้อง เมนู หรือปุ่มสำคัญ</li>
              <li>ปรับสี ฟอนต์ มุมโค้ง และเงาใน <code>style.md</code> ให้เป็น CI ของคุณเองได้ทั้งหมด</li>
            </ul>
            <div className="guide-links">
              <a href="https://github.com/ManageWithNoobItGuy/noobit-text-overlay" target="_blank" rel="noreferrer">
                อ้างอิงต้นฉบับ: noobit-text-overlay (GitHub) ↗
              </a>
            </div>
          </section>
        )}

        {tab === 'davinci' && (
          <section className="guide-section">
            <h3>4. การใช้งานกับ DaVinci Resolve (เวอร์ชันฟรี)</h3>
            <p>
              ระบบนี้ออกแบบมาให้ทำงานร่วมกับ <strong>DaVinci Resolve เวอร์ชันฟรี</strong> ผ่านไฟล์{' '}
              <code>FCPXML 1.9</code> โดยไม่ต้องซื้อเวอร์ชัน Studio เลยครับ
            </p>
            <h4>ขั้นตอนที่ 1: Export Timeline ออกไปให้ AI ตัด (กรณีเริ่มจาก Resolve)</h4>
            <ol className="guide-list">
              <li>วางคลิปดิบเรียงต่อกันบน <strong>Video Track 1</strong> (ถ้าอัดเสียงแยก ให้ Auto-Sync ภาพกับเสียงให้เรียบร้อยก่อน)</li>
              <li>คลิกขวาที่ Timeline ใน Media Pool → <code>Timelines</code> → <code>Export</code> → เลือก <strong>FCPXML 1.9</strong> (ใช้ไฟล์ <code>.fcpxml</code> เดี่ยว ไม่ใช้ <code>.fcpxmld</code>)</li>
              <li><em>หรือถ้าเริ่มจาก Dead Air Cutter:</em> โยนคลิปลง <code>inbox</code> แล้วกดปุ่ม <strong>xml</strong> เพื่อรับไฟล์ <code>.fcpxml</code> ได้เลย</li>
            </ol>
            <h4>ขั้นตอนที่ 2: นำไฟล์ Rough Cut กลับเข้า Resolve</h4>
            <ol className="guide-list">
              <li>ไปที่เมนู <code>File</code> → <code>Import</code> → <code>Timeline...</code> แล้วเลือกไฟล์ <code>.fcpxml</code> ที่ตัดเสร็จแล้ว</li>
              <li>ตรวจดูจุดที่มี <strong>Marker สีแดง</strong> (คลิกอ่านเหตุผลที่ AI ตัด และลากขอบคลิปยืดกลับได้ทันทีถ้าอยากแก้)</li>
            </ol>
            <h4>ขั้นตอนที่ 3: วางซ้อน Text Overlay / Motion B-Roll และ Render</h4>
            <ol className="guide-list">
              <li>Import ไฟล์ <code>&lt;timeline&gt; text only.fcpxml</code> เข้ามาเป็นอีก Timeline หนึ่ง</li>
              <li>เปิด Timeline ข้อความนั้น กด <code>Ctrl+A</code> → <code>Ctrl+C</code> แล้วนำไป <code>Ctrl+V</code> วางบน <strong>Video Track 2</strong> เหนือ Timeline หลัก (ไฟล์ ProRes 4444 มี Alpha พื้นหลังโปร่งใส จึงซ้อนทับได้เลย)</li>
              <li>ไปที่แท็บ <strong>Deliver</strong> เลือก Format <code>MP4</code> / Codec <code>H.264</code> แล้วกด Render จบงาน</li>
            </ol>
          </section>
        )}

        {tab === 'design-system' && (
          <section className="guide-section">
            <h3>5. Design System (CI) สำหรับงานวิดีโอ — Team Digital</h3>
            <p>
              งานวิดีโอ, Text Overlay และ Motion B-Roll ทั้งหมดอ้างอิงจากไฟล์ CI ต้นฉบับเดียวของ Team Digital:
            </p>
            <ul className="guide-list">
              <li>
                <strong>CI หลัก (TEAM DIGITAL DESIGN LOCK v1.0):</strong>{' '}
                <code>C:\PARA\2-Areas\teamdigital\marketing\knowledge\TEAMDIGITAL_CI.txt</code>
                <br />
                <span>พื้นกรมท่า (#061A2E / #07182D), สีเน้นฟ้า (#51CBE6), ฟอนต์ Kanit / Sarabun, การ์ดมุมโค้ง 20px</span>
              </li>
              <li>
                <strong>ธีมเสริม (เฉพาะคลิปคอร์ส TikTok):</strong>{' '}
                <code>C:\PARA\2-Areas\teamdigital\marketing\knowledge\TIKTOK_CI.txt</code>
              </li>
            </ul>
            <p>
              สกิล <code>vdo-text-overlay</code> ถูกปรับสี ฟอนต์ และมุมโค้งให้ตรงกับ <code>TEAMDIGITAL_CI.txt</code> แล้ว
            </p>
            <h4>วิธีสร้าง/ปรับ Design System เพิ่มเติม (กรณีทำแบรนด์อื่น)</h4>
            <ol className="guide-list">
              <li>
                <strong>สร้างจากเว็บไซต์ของธุรกิจคุณเอง (เร็วที่สุด):</strong> ส่ง URL เว็บไซต์หรือภาพหน้าเว็บ + โลโก้ให้ AI
                สกัดสีหลัก สีรอง ฟอนต์ มุมโค้ง และ Tone of Voice ออกมาเป็น <code>design.md</code>
              </li>
              <li>
                <strong>ปรับจากแบรนด์อ้างอิงที่ชอบ:</strong> นำ <code>design.md</code> ต้นแบบมาให้ AI ปรับโดยระบุชื่อแบรนด์
                กลุ่มเป้าหมาย จุดเด่น และแนบโลโก้ของคุณเข้าไป
              </li>
            </ol>
            <h4>เคล็ดลับตรวจสอบก่อนใช้งานจริง</h4>
            <p>
              สั่งให้ AI แปลง <code>design.md</code> เป็นหน้าเว็บตัวอย่าง (Style Guide Preview) เพื่อดูคู่สี ฟอนต์ และตัวอย่างกล่องข้อความจริง
              เมื่อพอใจแล้วจึงนำค่าสีและฟอนต์ไปใส่ใน <code>style.md</code> ของ Text Overlay และ Motion B-Roll
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
