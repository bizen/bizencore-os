# bizencore

タスクリストが中心のアプリ。切り替えると文字数カウントに行ける。

- **`/`** — タスクリスト（ローカル保存、**サインイン不要**、全操作がキーボードで完結）
- **`/count`** — 文字数カウント（ローカル保存）

タスクはブラウザの localStorage に保存される。サインインは任意で、
した場合だけ Convex 経由で他の端末と同期する。

## キーボード

| キー | 動作 |
| --- | --- |
| `Enter` | 下に新しい行 |
| `↑` / `↓` | 行を移動 |
| `→` | 行末から右へ抜けてメタ欄へ |
| `← / →` | メタ欄（種別 / today / 期限 / 削除など）を歩く。`←` で本文へ戻る |
| `Tab` / `⌘→` | サブタスクにする（1段下げる） |
| `⇧Tab` / `⌘←` | 1段上げる |
| `⌘↑` / `⌘↓` | 行ごと並べ替え（子も一緒に動く） |
| `⌘Enter` | 完了 / 未完了 |
| `⇧Enter` | メモを開く |
| `⌥T` | today に入れる / 外す |
| `⌥E` | 右パネルの作業想定時間へ移動（`30` / `45m` / `1.5h` / `1h30`） |
| `⌥M` | クエスト種別（なし→橙→青）を切り替え。ラベルの行では色 |
| `⌥S` | ラベルを追加 |
| `⌥C` | 完了を整理（完了済みへ移す） |
| `⌥⇧C` | 完了を削除 |
| `⌘⌫` / 空行で `⌫` | 行を削除 |
| `⌘Z` | 取り消し |
| `⌥1` / `⌥2` / `⌥3` | all / board / today 表示（board はラベルごとの列を横に並べる） |
| `⌥4`〜`⌥9` | 追加順で先頭6件のラベルフォーカスへ切り替え |
| `⌘F` | 検索 |
| `⌘K` | tasks ⇄ count |
| `⌘/` | ショートカット一覧 |
| `Esc` | 編集をやめる / 検索を消す |

Windows / Linux では `⌘` を Ctrl、`⌥` を Alt に読み替える。

気づきにくいキーはフッターにも小さく出してあるので、`⌘/` を開かなくても目に入る。
定義は `src/lib/shortcuts.ts` の1か所にあり、ヘルプとフッターの両方がそこを読む
（`footer` を持つものだけがフッターに並ぶ）。

> `⌥` 側に寄せているのは、`⌘T` / `⌘N` などがブラウザに奪われて
> `preventDefault()` が効かないため。

## 見た目の決めごと

**完了済みの棚** — フッターの下に置いてある。開いた状態が既定。

チェックしただけではタスクはその場に残る。フッターの `完了を整理`（`⌥C`）を
押したときに、完了したものがまとめて棚へ移る。どのラベルの下にあっても
引き上げるので、リストにはこれからやるぶんだけが残る。
`⌥⇧C` で完了を削除。どちらも `⌘Z` で戻せる。

棚の中でチェックを外すと、元いた場所へそのまま戻る（並び順は変えておらず、
`filed` の印を外すだけのため）。サブタスクは親の内訳なので棚へは移さない。

**行の形** — 左に状態、中央に本文、右にメタ欄。メタ欄は
`種別 / today / 期限 / 削除 / 詳細` のメタ欄を置く。本文の行末で `→` を押すと
メタ欄へカーソルが移り、`←` `→` で歩いて Enter で操作できる。
作業想定時間は右パネルか `⌥E` で入力する。ラベルの行には色とフォーカスの操作がある。
フッターには残っているぶんの想定時間の合計が出る。

**色の役割を分ける** — 青は「選択・today」、氷のシアン
（`--done-color`）は「完了」だけ。この2つが混ざらないようにしている。

**完了の演出** — 0.5 秒で終わる4層。塗りがわずかに行き過ぎて立ち上がり、
チェックの線が描かれ、輪がひとつ外へ抜け、行がひと呼吸だけ光って沈む。
親を完了すると子も完了するので、上から 50ms ずつずらして点く。
戻すときは演出なし。`prefers-reduced-motion` では色の変化だけ残る。

完了しても本文に取り消し線は引かない。本文とメタだけ沈めて、
チェックの氷色は明るいまま残す（済んだ印が列として貯まっていく）。

## データモデル

タスクとラベルを1本の木で持つ。

- ルート直下にラベル（保存上の型名は互換のため `section`）とタスクが並ぶ
- ラベルには色を付けられる（`blue` / `violet` / `pink` / `amber` / `green`）。
  削除の隣のボタンから選ぶ
- 完了済みの棚は `filed` の印で表す。位置（`parentId` と `order`）は動かさない
- タスクには作業想定時間（分）と期限（日付、任意で時刻）を持たせられる
- 何も書かれていない行は、そこから離れた時点で消える（最後の1行は残る）
- タスクは子タスクを持てる（最大 4 階層）
- 並び順は兄弟内の fractional order。同期しても衝突しにくい
- 削除はトゥームストーン（`deletedAt`）。同期先にも削除が伝わる
- `today` は割り当てた日付（`assignedDate`）。日付が変われば自動的に外れる

実体は `src/lib/taskModel.ts`（純粋関数）と `src/lib/taskStore.ts`
（localStorage ストア + undo）。

## 同期（任意）

サインインすると `src/components/SyncBridge.tsx` が働く。

- ローカルが正。突き合わせは**欄ごと**に新しい方を採る（`src/lib/itemMerge.ts`）。
  行ごとに採ると、AI が文言を、人がメモを同時に直したときに片方が黙って消えるため
- 欄ごとの変更時刻は `stamps` に持つ。一緒に動く欄は組にする（位置は `parentId` + `order`、
  完了は `done` + `filed`）。`stamps` の無い古い行は、どの欄も `updatedAt` とみなす
- 時刻は、それまでに見たどの時刻よりも後にする。端末の時計が遅れていても、
  他の変更を見てから書いた編集が負けないように
- 同じ規則をブラウザ（`taskStore.mergeRemote`）、サーバの push（`convex/sync.ts`）、
  MCP の書き込み（`convex/mcpTasks.ts`）の3か所で使う
- 他の端末や AI の変更で勝った欄は取り消し履歴にも写す。`⌘Z` で自分の編集を
  戻したときに、AI の変更まで巻き戻さないように
- 初回サインイン時に、旧スキーマ（`tasks` / `taskListEntries`）のタスクを
  一度だけ新しいツリーへ取り込む（旧「見出し」はそのままラベルになる）

## MCP（任意）

Claude などの AI から、このタスクリストを読み書きできる。

`/mcp` は Vercel Functions（`api/mcp.ts`）。Clerk の OAuth で人を特定し、
その userId を Convex の `/mcp/*`（`convex/http.ts`）へ渡す。共有の秘密は
Authorization ヘッダで送る。Convex の関数の引数に載せると実行ログに残るため。
書き込み先は `syncItems` なので、開いているブラウザが既存の同期で拾う。

| ツール | 動作 |
| --- | --- |
| `list_tasks` | 残っているタスク、ラベル名、id を返す。`label`、`today`、`query` で絞り込み。`include_subtasks` で子も独立した候補にする。既定で50件、最大100件ずつ。続きは `next_offset` を `offset` に渡す |
| `get_task` | 指定IDの最新メモ、添付、完了条件、親の経路、全階層のサブタスクを読む |
| `attach_context` | 新しい資料またはリンクを添付。同一内容の再送は既存IDを返す。既存資料と同じ題名なら新規作成せず更新を促す |
| `update_context` | `attachment_id` と最新の `expected_revision` で文章資料を更新。`replace` は置換、`append` は同じ資料への追記。古い版からの更新は拒否 |
| `work_on_task` | ラベル（全件も可）→未完了タスクの順に選び、最新情報と作業指示を返す。タスク選択では検索・30件ずつのページ移動・ラベル選択への戻りができる。フォーム非対応時は `task_id` で直接指定 |
| `open_task_picker` | MCP Apps対応クライアントに視覚的なタスクピッカーを開く。ラベル・Today・期限・検索で絞り、選んだIDだけを会話へ戻す。AIは `work_on_task(task_id)` で最新情報を再取得する |
| `record_task_progress` | 親は未完了のまま、検証済みサブタスクだけチェックし、残作業のサブタスクと途中経過を記録する。同名の直下サブタスクは増やさず、作業状況の資料も同じIDで更新する |
| `add_task` | 1件足す（メモ / 既存ラベル / 想定時間 / 親タスク指定） |
| `add_tasks` | まとめて足す。並びは渡した順。サブタスクも一緒に渡せる |
| `delete_task` | 消す（子も一緒）。MCP クライアントで対象を確認できたときだけ実行 |
| `complete_task` | 完了にする（子も一緒）。`done: false` で戻す |
| `update_task` | 文言・メモ・想定時間を直す。`today` に日付（YYYY-MM-DD）で today に入れる / 空文字で外す |
| `add_label` | ラベルを1つ作る（いちばん下に） |
| `move_task` | タスクを別のラベル、または別のタスクの下へ移す（子もついてくる） |
| `label_to_task` | ラベルをタスクに変える。中のタスクはサブタスクになる |

MCPプロンプト `work_on_task` も公開する。Claude Code CLIでは
`/mcp__bizencore__work_on_task` から起動できる。Codex CLIでは
`skills/bizencore-work-on-task` をユーザースコープにインストールすると、
`$bizencore-work-on-task` からラベル→タスクの会話選択を始められる。
このリポジトリで `mkdir -p ~/.agents/skills && cp -R skills/bizencore-work-on-task ~/.agents/skills/` を実行する。
Codex DesktopやClaude Code DesktopのCodeタブでは、チャットで
`work_on_task` の使用を依頼できる。
選択は MCP Apps ピッカー → クライアントの選択フォーム（elicitation）→ 普通の番号リストの順。
ピッカーを開いた後は選択を待ち、並行して別のフォームやリストを出さない。
MCP Apps が使えない場合だけフォームへ、フォームも使えない場合だけ
`list_tasks` でラベル（全件も可）、次にタスクを番号リストから選び、
選んだIDを `work_on_task` に渡す。どの選択方法でもAIは最新情報から目的・現状・
完了済み・残作業を整理する。詳細パネルとMCP Appsでは「検討する／実行する」を
選んでハンドオフできる（初期値は検討）。詳細パネルではこれと独立して
「MCPで進める／内容だけ渡す」を選ぶ。意図を選んだ場合はそのまま引き継ぎ、
未確認の場合だけ作業を進めたいか、方針や要件から相談したいか、
まず伝えたいことがあるかを聞いて回答を待つ。相談中は勝手に実装へ移らず、
着手の合意後に同じ会話で作業を続け、検証済みの完了か
途中経過・質問待ちの理由を記録する。MCP Apps のピッカーは本体と共通のCSS・ロゴ・タスクツリーを使う。

コンテキストの文章は資料として扱う。一覧の短い抜粋から全文ビューを開き、
Markdownの見出し・表・箇条書きを閲覧し、本文コピーとmd/txt書き出しができる。
アプリ内編集や日誌は作らない。エージェントは既存資料を読んでから更新・追記し、
別テーマの場合だけ新規資料を作る。本文は最大100,000文字、タスクの添付データは
合計512 KiB以内（外した資料の同期用データも含む）。上限超過は拒否し、本文は切り捨てない。
`list_tasks` は長い本文を抜粋し `text_truncated` を返す。更新前には `get_task` で全文を読む。

`add_task` は既存のラベルにしか入れない。無いラベルを指定したときは
MCP のエリシテーションで既存ラベルを選んでもらい、確認できなければ書き込まない。
削除も同様に確認が必要。エリシテーション非対応のクライアントでは、Web アプリから操作する。

必要な環境変数（Convex と Vercel の両方）:

```
MCP_SHARED_SECRET          両者で共有する秘密
CLERK_SECRET_KEY           Vercel 側のみ。OAuth トークンの検証に使う
CLERK_JWT_ISSUER_DOMAINS   Convex 側のみ。受け付ける Clerk のドメイン（カンマ区切り）
```

本番の Clerk は `bizencore.com`（Frontend API は `https://clerk.bizencore.com`）。
アプリは `https://app.bizencore.com`、`chrct.com` はそこへ転送する（`vercel.json`）。

Clerk を別のインスタンスへ移すとユーザー ID が変わるので、Convex のデータを
付け替える: `npx convex run migrations:moveUser '{"from":"user_…","to":"user_…"}'`

`CONVEX_SITE_URL` は任意。無ければ `VITE_CONVEX_URL` の
`.convex.cloud` を `.convex.site` に読み替える。

## スタック

- React 19 + Vite + TypeScript
- React Router v7
- Clerk（任意のサインイン）
- Convex（任意の同期）
- lucide-react（アイコン）
- IBM Plex Sans / IBM Plex Sans JP（本文）、JetBrains Mono（日数・件数）

## セットアップ

```bash
npm install
```

`.env.local`（同期を使う場合だけ必要）:

```
VITE_CONVEX_URL=https://<your-project>.convex.cloud
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx
```

> 環境変数が無くてもタスクと文字数カウントは動く。同期 UI が出ないだけ。

## 開発

```bash
npm run dev

# 同期を使う場合は別ターミナルで（_generated を生成）
npm run convex
```

## ビルド

```bash
npm run build
npm run preview
```

## ファイル構成

```
src/
  App.tsx                     シェル + ナビ + ルーティング
  index.css                   スタイル
  lib/
    taskModel.ts              ツリーの型と純粋関数
    taskStore.ts              localStorage ストア（undo 付き）
    taskDates.ts              日付まわり
  pages/
    TasksPage.tsx             タスクリスト（キーボード操作の本体）
    CountPage.tsx             文字数カウント
  components/
    SyncBridge.tsx            サインイン中だけ Convex と同期
    KeyboardHelp.tsx          ⌘/ のショートカット一覧
    task/
      TaskRow.tsx             1行
      DeadlineField.tsx       期限の入力ポップオーバー
convex/
  sync.ts                     pull / push / 旧スキーマの取り込み
  countStocks.ts              count のストック
  schema.ts
```
