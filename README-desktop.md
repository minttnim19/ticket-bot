# Ticket Bot Desktop

คู่มือนี้ใช้สำหรับรันและ build เวอร์ชัน Desktop App ของโปรเจกต์นี้

## ภาพรวม

Desktop app ตัวนี้ใช้:

- `Electron` เป็น shell ของแอป
- `Node.js + TypeScript` เป็น control server และ bot backend
- `Playwright` สำหรับ browser automation

ตัวแอปรองรับการทำงานทีละ 1 งานต่อครั้ง และรองรับการเปิดแอปได้เพียง 1 instance บนเครื่องเดียวกัน

## สิ่งที่ควรขึ้น Git

- `src/`
- `desktop/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `.env.example`
- `README-desktop.md`

## สิ่งที่ไม่ควรขึ้น Git

- `.env`
- `.auth/`
- `dist/`
- `release/`
- `node_modules/`

## ติดตั้ง

```bash
npm install
```

## รันแบบ Desktop ระหว่างพัฒนา

```bash
npm run desktop
```

ถ้าต้องการรันเป็น web control page แบบเดิม:

```bash
npm start
```

## Build สำหรับ Mac

บน macOS ให้ใช้:

```bash
npm run desktop:build:mac
```

หรือ build ทุก target ที่ config รองรับ:

```bash
npm run desktop:build
```

ไฟล์ output จะอยู่ในโฟลเดอร์ `release/`

ตัวอย่างไฟล์ที่ได้:

- `.dmg`
- `.zip`

## Build สำหรับ Windows

ควร build บนเครื่อง Windows หรือบน CI ที่ใช้ Windows runner

คำสั่ง:

```bash
npm run desktop:build:win
```

ไฟล์ output จะอยู่ใน `release/`

ตัวอย่างไฟล์ที่คาดว่าจะได้:

- `Ticket Bot-1.0.0-win-x64.exe`

## วิธีแจกเพื่อนใช้งาน

### เพื่อนใช้ Mac

ส่งไฟล์จาก `release/` เพียงไฟล์ใดไฟล์หนึ่ง เช่น:

- `.dmg`
- หรือ `.zip`

### เพื่อนใช้ Windows

ส่งไฟล์ installer `.exe` ที่ build จาก Windows โดยตรง เช่น:

- `Ticket Bot-1.0.0-win-x64.exe`

ไม่ต้องส่ง:

- โฟลเดอร์ `win-unpacked/` หรือ `win-x64-unpacked/`
- `builder-debug.yml`
- `builder-effective-config.yaml`
- `latest.yml`
- `.blockmap`

สรุปสั้น ๆ:

- ถ้าเพื่อนใช้ Mac: ส่ง `.dmg` หรือ `.zip`
- ถ้าเพื่อนใช้ Windows: ส่ง `.exe`
- ไม่ต้อง zip ทั้งโฟลเดอร์ `release/`

## Environment ที่แนะนำ

ตัวอย่าง `.env`

```env
PORT=3000
BROWSER_CHANNEL=chrome
```

หมายเหตุ:

- ถ้าเครื่องผู้ใช้มี Google Chrome อยู่แล้ว ค่า `BROWSER_CHANNEL=chrome` จะใช้งานง่ายสุด
- session ของผู้ใช้จะถูกเก็บ local ตาม `storageStatePath` ที่ตั้งไว้ใน config

## ข้อจำกัดปัจจุบัน

- รองรับ `ทีละ 1 bot job`
- รองรับ `แอปทีละ 1 instance`
- ถ้าจะรองรับหลายงานพร้อมกัน ต้องแยก browser context และ job queue เพิ่ม

## แนะนำก่อนส่งให้เพื่อน

1. ทดสอบเปิดแอปจากไฟล์ build จริงก่อน
2. ทดสอบ login, verify, enroll, seat flow บนเครื่อง target
3. ยืนยันว่าเครื่องนั้นมี Chrome หรือ browser runtime ที่ใช้งานได้
4. อย่าส่งไฟล์ `.env` หรือ `.auth/` ไปพร้อม source โดยไม่ตั้งใจ
