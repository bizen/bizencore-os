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
| `← / →` | メタ欄（種別 / today / 想定時間 / 削除）を歩く。`←` で本文へ戻る |
| `Tab` / `⌘→` | サブタスクにする（1段下げる） |
| `⇧Tab` / `⌘←` | 1段上げる |
| `⌘↑` / `⌘↓` | 行ごと並べ替え（子も一緒に動く） |
| `⌘Enter` | 完了 / 未完了 |
| `⇧Enter` | メモを開く |
| `⌥T` | today に入れる / 外す |
| `⌥E` | 作業想定時間（`30` / `45m` / `1.5h` / `1h30`） |
| `⌥M` | クエスト種別（なし→橙→青）を切り替え。ラベルの行では色 |
| `⌥S` | ラベルを追加 |
| `⌥C` | 完了を整理（完了済みへ移す） |
| `⌥⇧C` | 完了を削除 |
| `⌘⌫` / 空行で `⌫` | 行を削除 |
| `⌘Z` | 取り消し |
| `⌥1` / `⌥2` / `⌥3` | all / today / board 表示（board はラベルごとの列を横に並べる） |
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
`種別 / today / 想定時間 / 削除` の固定幅の格子なので、想定時間が
ページの縦に一列で揃う。本文の行末で `→` を押すとこの格子へカーソルが移り、
`←` `→` で歩いて Enter で操作できる。ラベルの行では `色 / 削除` になる。`30m` `1h30` `2h` は等幅（JetBrains Mono）。フッターには残っているぶんの合計が出る。

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
- タスクには作業想定時間（分）を持たせられる。期限という概念は持たない
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
| `list_tasks` | 残っているタスク、ラベル名、id を返す。`label` で絞る。`today` に日付を渡すと today の分と残りの見積もり合計（`today_remaining_minutes`） |
| `add_task` | 1件足す（メモ / 既存ラベル / 想定時間 / 親タスク指定） |
| `add_tasks` | まとめて足す。並びは渡した順。サブタスクも一緒に渡せる |
| `delete_task` | 消す（子も一緒）。頼まれたときだけ |
| `complete_task` | 完了にする（子も一緒）。`done: false` で戻す |
| `update_task` | 文言・メモ・想定時間を直す。`today` に日付（YYYY-MM-DD）で today に入れる / 空文字で外す |
| `add_label` | ラベルを1つ作る（いちばん下に） |
| `move_task` | タスクを別のラベル、または別のタスクの下へ移す（子もついてくる） |
| `label_to_task` | ラベルをタスクに変える。中のタスクはサブタスクになる |

`add_task` は既存のラベルにしか入れない。無いラベルを指定したときは
ルートに置いて `label_not_found` で知らせる（勝手にラベルが増えないように）。

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
      DueDateChip.tsx         期限のポップオーバー
      DueDateCalendar.tsx     カレンダー
convex/
  sync.ts                     pull / push / 旧スキーマの取り込み
  countStocks.ts              count のストック
  schema.ts
```
