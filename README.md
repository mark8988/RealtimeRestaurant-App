# 門口菜單助手

Android 10 以上的餐廳迎賓平板 App。客人可選迎賓小幫手或主廚，按「開始語音」後連續提問，也可輸入文字。可詢問餐點、價格及供應狀態，或依預算與口味找餐點。按「新對話」會清除畫面和追問上下文。

## 專案結構

- `lib/main.dart` 是平板入口，`lib/restaurant_api.dart` 負責菜單、詢問和 WAV 請求。
- `lib/voice/` 和 `assets/models/silero_vad/` 沿用原版的 Silero VAD 與斷句邏輯。平板在播放語音時暫停收音。
- `server/index.mjs` 提供問答和菜單 API。`server/seed.json` 提供示範菜單。
- `Admin/` 是 ASP.NET Core MVC 店員後台，沿用 SGS 樣板的 Cookie 登入、共用 Razor 側欄、列表與新增／編輯分頁。後台由伺服器端服務存取菜單 API，與平板共用同一份版本資料。
- `server/voice.mjs` 串接 llama-server。`server/stt_service.py` 執行 faster-whisper，並使用 ElevenLabs Text to Dialogue WebSocket 合成角色語音。
- `server/server.test.mjs` 和 `server/test/` 驗證菜單發布與語音服務介面。

原版使用持續 WebSocket 串流。本版沿用 STT → LLM → TTS 服務鏈，以 HTTP 逐回合傳輸 WAV，收到完整回覆後播放。平板每 30 秒同步已發布菜單，也可以手動更新。斷線時顯示上次成功下載的菜單。

## 啟動伺服器

在專案根目錄執行。需要 Node.js 22+、Python 3.12、.NET 10 SDK、llama-server，以及兩個可用的 ElevenLabs voice ID。

1. 啟動原先的 llama-server，確認其 `/v1/chat/completions` 可接受請求。
2. 在第一個 PowerShell 視窗啟動語音服務。GPU 可沿用原專案已配置 CUDA 12 cuBLAS 與 cuDNN 的 Python 環境，預設 `large-v3-turbo`、`cuda`、`float16`。CPU 環境可改設 `WHISPER_DEVICE=cpu` 和 `WHISPER_COMPUTE_TYPE=int8`。

   ```powershell
   python -m pip install -r server/requirements-stt.txt
   $env:ELEVENLABS_API_KEY = '<伺服器金鑰>'
   $env:TTS_VOICE_HOST = '<迎賓聲音 ID>'
   $env:TTS_VOICE_CHEF = '<主廚聲音 ID>'
   python server/stt_service.py
   ```

3. 在另一個 PowerShell 視窗啟動菜單服務。可選填 `LLM_MODEL` 和 `LLM_API_KEY`。語音服務預設位於 `http://127.0.0.1:8091`，可用 `VOICE_SERVICE_URL` 覆蓋。

   ```powershell
   $env:LLM_BASE_URL = 'http://127.0.0.1:8080'
   $env:ADMIN_TOKEN = '<店員權杖>'
   $env:DEVICE_TOKEN = '<平板權杖>'
   node server/index.mjs
   ```

4. 在第三個 PowerShell 視窗啟動店員後台。使用和菜單服務相同的 `ADMIN_TOKEN`，並設定店員帳密。預設管理網址為 `http://127.0.0.1:5080/Backend/Login`。若菜單服務使用其他網址，可指定 `MENU_API_URL`。

   ```powershell
   $env:ADMIN_USERNAME = '<店員帳號>'
   $env:ADMIN_PASSWORD = '<店員密碼>'
   $env:ADMIN_TOKEN = '<與菜單服務相同的內部權杖>'
   dotnet run --project Admin/Restaurant.Admin.csproj
   ```

   修改餐點後先儲存草稿，再發布菜單。發布會增加版號。菜單服務的資料預設儲存在 `server/data/`，可用 `DATA_DIR` 調整。

平板連線使用 HTTPS 反向代理。開發時可用 USB 的 `adb reverse` 或 Android 模擬器的 `10.0.2.2`。管理與外部服務金鑰留在伺服器。ElevenLabs 接收要朗讀的回答文字，原始錄音由私有主機辨識。

## Android 建置與驗證

需要 Flutter 3.47.7 / Dart 3.13.5、Android SDK 與 JDK 21。Windows 若遇到 Gradle 路徑錯誤，從 ASCII 路徑的工作副本建置。

```powershell
flutter pub get
flutter analyze
dotnet build Admin/Restaurant.Admin.csproj
adb reverse tcp:8787 tcp:8787
flutter run -d '<裝置 ID>' --dart-define=RESTAURANT_API_URL=http://127.0.0.1:8787/ --dart-define=RESTAURANT_DEVICE_TOKEN='<平板權杖>'
node --test --test-isolation=none server/server.test.mjs server/test/voice.test.mjs
node --test --test-isolation=none Admin/tests/workflow.mjs
```

建置測試 APK 可用 `flutter build apk --debug`，搭配相同的 `--dart-define`。正式 APK 使用正式簽章和 HTTPS API 網址。APK 內的裝置權杖應可撤換。

實機驗收時，先發布一道測試餐點，確認平板同步版號與價格。用兩個角色各做一次語音提問，再追問同一道餐點的價格。按「新對話」確認取消前一個請求。斷開後端時，確認平板保留離線菜單。
