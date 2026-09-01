<p align="center">
  <img src="assets/banner.svg" alt="ValoUtils" width="100%">
</p>

<p align="center">
  <a href="https://github.com/windowsedd/ValoUtils/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/windowsedd/ValoUtils?style=flat-square&color=FF4655&labelColor=0E1419"></a>
  <a href="https://github.com/windowsedd/ValoUtils/actions/workflows/build.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/windowsedd/ValoUtils/build.yml?style=flat-square&labelColor=0E1419"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0E1419?style=flat-square">
  <img alt="Stack" src="https://img.shields.io/badge/Tauri%202-React%2019-FF4655?style=flat-square&labelColor=0E1419">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>繁體中文</strong>
</p>

ValoUtils 是一款非官方的 Windows 版 VALORANT 桌面工具。它能管理完整的遊戲設定檔，並將帳號、對戰、即時戰局、社交、商店、戰鬥通行證與收藏資訊整合在同一個應用程式中。ValoUtils 直接使用電腦上已登入的 Riot Client 工作階段，不需要另外建立 ValoUtils 帳號或再次登入。

## 功能

### 設定檔

- 將目前的 VALORANT 設定儲存為具名設定檔，之後可隨時還原。
- 不套用設定也能重新命名、複製、刪除及檢視設定檔。
- 檢視解碼後的一般、控制、準星、音效與影像設定，並可預覽準星及比較設定檔差異。
- 透過有效期限為 90 天的 10 字元代碼分享設定檔，或匯入其他玩家提供的代碼。

### 戰績與對戰紀錄

- 查看目前與歷史最高競技牌位、積分進度及近期競技更新。
- 瀏覽包含地圖、特務圖片、比分摘要與可展開計分板的對戰紀錄。
- 檢視 ACS、ADR、K/D/A、爆頭率及首殺等個別玩家數據。
- 從對戰結果開啟玩家資料，查看牌位摘要及近期表現。

### 即時對戰

- 自動更新目前的隊伍、選角階段或進行中的對戰。
- 查看雙方陣容、組隊關係、已選特務、競技牌位、過往賽季牌位與近期狀態。
- 遇到短暫的 API 異常或速率限制時，保留最近一次可用的戰局資料。

### 好友與聊天

- 瀏覽 Riot 好友，查看即時上線狀態、佇列、地圖、比分、隊伍人數與最後上線時間。
- 開啟好友資料，查看牌位及近期對戰資訊。
- 在應用程式內收發私人訊息、接收即時狀態更新，並翻譯聊天內容。
- VALORANT 執行期間，可透過聊天指令系統使用支援的隊伍、團隊及全體聊天操作。

### 商店、戰鬥通行證與收藏

- 查看每日優惠、精選組合包、配件、夜市商品及貨幣餘額。
- 追蹤目前戰鬥通行證的經驗值、等級進度及付費版本擁有狀態。
- 以搜尋及分類篩選瀏覽已擁有的武器造型與配件。

### 工具與便利功能

- 透過 `GameName#Tag` 或 PUUID 查找玩家，檢視其牌位與近期對戰，並瀏覽自己的收藏。
- 開發或排查整合問題時，可使用內建的 Riot API 參考文件。
- 介面支援英文、韓文與繁體中文。
- 啟用自動更新時，會在啟動時及每小時檢查更新，並以 minisign 驗證更新檔。

## 系統需求與隱私

- x64 架構的 Windows 10 或 Windows 11。
- **Riot Client 必須保持執行。** ValoUtils 會讀取本機 Riot Client 的 lockfile，並以目前登入的帳號驗證請求。
- **還原設定檔前必須關閉 VALORANT。** Riot Client 會在下次啟動遊戲時套用還原後的設定。

ValoUtils 不會要求 Riot 密碼，也不會建立雲端帳號。設定檔與應用程式設定皆儲存在電腦的 `%APPDATA%\ValoUtils`。應用程式會與 Riot 本機客戶端及私人遊戲服務通訊、取得公開遊戲素材，並將匿名使用事件傳送至 Aptabase。只有在使用者明確建立分享代碼時，設定檔資料才會上傳至 pastes.dev。使用者要求翻譯聊天內容時，所選文字會傳送至設定的 Google Translate 或 DeepL 服務。

## 安裝

請從 [GitHub Releases](https://github.com/windowsedd/ValoUtils/releases/latest) 下載最新安裝程式。

| 檔案 | 說明 |
| --- | --- |
| `ValoUtils_x.x.x_x64-setup.exe` | NSIS 安裝程式，僅為目前使用者安裝，不需要系統管理員權限。 |

安裝程式目前尚未使用 Authenticode 簽章，因此 Windows SmartScreen 可能在首次啟動時顯示警告。若安裝程式是從本專案的 Releases 頁面下載，請選擇「其他資訊」→「仍要執行」。後續更新會由應用程式下載並驗證。

## 從原始碼建置

請先安裝 [Bun](https://bun.sh)、Rust 穩定版工具鏈（MSVC 目標），以及 [Tauri 的 Windows 必要環境](https://v2.tauri.app/start/prerequisites/#windows)。

```bash
git clone https://github.com/windowsedd/ValoUtils.git
cd ValoUtils

bun install
bun run dev
bun run build
```

提交變更前，請執行前端與 Rust 檢查：

```bash
bun test
bun run lint

cd src-tauri
cargo check
cargo clippy
cargo test --lib
```

`bun run dev` 會啟動 Vite 與支援熱更新的 Tauri 開發版應用程式；`bun run build` 會產生用於發行的 NSIS 安裝程式。

## 架構

```text
src-tauri/          Rust 後端
  src/commands/     依功能分類的 Tauri 指令
  src/riot/         Riot Client lockfile、本機 API 與 pd/glz API client
  src/xmpp/         Riot 聊天連線與訊息處理
  src/store.rs      以 JSON 儲存的本機應用程式資料

src/                在 WebView2 執行的 React 前端
  pages/            設定檔、對戰、社交、商店與工具等功能頁面
  components/       共用檢視器、計分板、導覽與控制元件
  util/             Tauri IPC 橋接層、Riot 輔助模組、素材與共用工具
```

大多數前端 IPC 都會經過 `src/util/tauri-bridge.ts`。這個橋接層會將 `settings:profile:load` 之類的通道名稱對應至 `settings_profile_load` 等 Rust 指令，再透過相同的監聽介面傳遞指令回覆與後端事件。匯入分享設定檔時，則由 `src/util/share.ts` 中的小型輔助函式直接呼叫 `invoke()`。

驗證帳號時，Rust 後端會讀取 Riot Client lockfile，並透過 `127.0.0.1` 與本機客戶端通訊。帳號與遊戲資料則來自 Riot 私人的 Player Data (`pd`) 與 Game (`glz`) 服務，聊天功能使用獨立的 XMPP 連線。設定檔在本機儲存時會保留原始編碼，還原時不會遺失 ValoUtils 尚未識別的設定。

## 發行流程

推送 `v*` tag 時，GitHub Actions 會啟動發行工作流程。它會確認 tag 與專案版本一致，建置並簽署 Tauri 更新檔，接著建立包含 NSIS 安裝程式與更新資訊清單的 GitHub Release 草稿。請先在乾淨的 `master` 分支執行發行輔助工具，同步版本資料並建立發行 commit 與 annotated tag，再推送至遠端：

```bash
bun run version 1.0.8
git push origin HEAD:master --follow-tags
```

## 免責聲明

ValoUtils 是非官方第三方工具，與 Riot Games 沒有從屬、認可或合作關係。它依賴 Riot 的私人 API；這些 API 可能隨時變更、限制存取或停止運作。

還原設定檔會覆寫目前的 VALORANT 設定。若日後可能需要恢復現有配置，請先將它儲存為設定檔。
