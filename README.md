# 4 Color Text

4色ボールペンの色分けメモをテキストとして扱うための、Tauri ベースのデスクトップエディタです。

保存形式は独自拡張子 `.4cm` です。色や太字の情報は `<red>...</red>` や `<bold>...</bold>` のようなタグ付きテキストとして保存されるため、通常のテキストエディタで開いても内容を確認できます。

## 主な機能

- タブ付きメモ編集
- 4色の文字色切り替え
- 太字装飾
- スクリーンショットの貼り付け
- Undo / Redo
- UTF-8 固定保存
- 改行コードの切り替え
  - デフォルトは `CRLF`
- `.4cm` ファイルの保存 / 読み込み
- セッション保存
  - 開いていたタブ構成を次回起動時に復元

## ショートカット

- `Ctrl + D`: 黒
- `Ctrl + R`: 赤
- `Ctrl + B`: 青
- `Ctrl + G`: 緑
- `Ctrl + Shift + B`: 太字
- `Ctrl + V`: 画像貼り付け
- `Ctrl + Tab`: 次のタブ
- `Ctrl + Shift + Tab`: 前のタブ
- `Ctrl + N`: 新規タブ
- `Ctrl + O`: 開く
- `Ctrl + S`: 保存
- `Ctrl + Shift + S`: 名前を付けて保存
- `Ctrl + W`: タブを閉じる
- `Ctrl + Z`: Undo
- `Ctrl + Y`: Redo

## 技術構成

- フロントエンド: `Vite + TypeScript`
- デスクトップアプリ: `Tauri v2`
- バックエンド処理: `Rust`
- パッケージング: `NSIS`

## ディレクトリ構成

- [src/main.ts](/home/fukushima/lab/codexcli_lab/4colortext/src/main.ts): フロントエンドのメイン実装
- [src/styles.css](/home/fukushima/lab/codexcli_lab/4colortext/src/styles.css): UI スタイル
- [src-tauri/src/lib.rs](/home/fukushima/lab/codexcli_lab/4colortext/src-tauri/src/lib.rs): Tauri コマンドとウィンドウ制御
- [src-tauri/tauri.conf.json](/home/fukushima/lab/codexcli_lab/4colortext/src-tauri/tauri.conf.json): Tauri 設定
- [spec.md](/home/fukushima/lab/codexcli_lab/4colortext/spec.md): 元仕様

## 開発環境

このリポジトリは `Ubuntu 24.04` で動作確認しています。

必要な主なツール:

- `node`
- `npm`
- `rustup` / `cargo`

Ubuntu 系では、Tauri 用に以下のライブラリが必要です。

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  libxdo-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

## セットアップ

```bash
npm install
```

## 開発起動

フロントエンドのみ:

```bash
npm run dev
```

Tauri アプリとして起動:

```bash
npx tauri dev
```

## ビルド

フロントエンドの本番ビルド:

```bash
npm run build
```

Linux 上で Tauri のデバッグビルド:

```bash
npx tauri build --debug
```

## Windows 向け `setup.exe` の生成

Rust の Windows ターゲットと `cargo-xwin` を使って、Ubuntu から Windows 向け NSIS インストーラを生成できます。

事前準備:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
```

ビルド:

```bash
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

生成物:

- `src-tauri/target/x86_64-pc-windows-msvc/release/four-color-text.exe`
- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/4 Color Text_0.1.0_x64-setup.exe`

## 保存形式

`.4cm` ファイルはタグ付きテキストとして保存されます。画像は `.4cm` と同じ階層の `assets/メモ名/` フォルダへ保存し、本文からは相対パスで参照します。

```txt
通常の文字<red>赤い文字</red>
<image>assets/meeting/img-20260420-001.png</image>
<blue><bold>青の太字</bold></blue>
```

この形式により、専用アプリ以外で開いても色付き箇所の構造を追えます。

## 補足

- セッション復元用のタブ情報は `session.json` として OS のアプリ設定ディレクトリに保存されます
  - Windows では通常 `%APPDATA%\com.codexlab.fourcolortext\session.json`
- Undo / Redo の履歴はメモリ上のみで保持します
- Windows ビルドは未署名です
  - 配布時には SmartScreen 警告が出る可能性があります
