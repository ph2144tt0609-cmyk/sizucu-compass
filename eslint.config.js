import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // ダッシュボード系は .jsx（型なし）。ここを対象に入れていなかったため
  // 「消した変数をまだ参照している」類の間違いが build もすり抜けていた（2026-09-04）。
  // .jsx も no-undef が効くようにする。
  {
    files: ['**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // JSX の自動ランタイムでは React の import は不要だが、既存ファイルは慣習として
      // 書いてあるので未使用扱いにしない。`{ count, ...rest }` で捨てる書き方も許す。
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^React$', ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
      // 日本語の全角スペースは組版として意図して使っている
      'no-irregular-whitespace': ['error', { skipJSXText: true, skipTemplates: true }],
      // 「薬局・年度を切り替えたら選択月をそろえる」など既存の作りに合わせて警告どまりにする
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
