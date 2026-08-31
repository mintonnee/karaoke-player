import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'sidecar/.venv'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // 테스트 픽스처(plain JS)에는 TS 전용 규칙을 적용하지 않는다
    files: ['**/__tests__/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // 스펙 §4.1/§9: 렌더러는 AudioContext를 직접 만지지 않는다. 오직 audio/ 구현체 내부에서만.
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/audio/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'AudioContext',
          message: 'AudioEngine 구현체(src/renderer/src/audio) 내부에서만 사용한다 (spec §4.1)'
        },
        {
          name: 'webkitAudioContext',
          message: 'AudioEngine 구현체 내부에서만 사용한다 (spec §4.1)'
        },
        {
          name: 'OfflineAudioContext',
          message: 'AudioEngine 구현체 내부에서만 사용한다 (spec §4.1)'
        },
        { name: 'AudioWorklet', message: 'AudioEngine 구현체 내부에서만 사용한다 (spec §4.1)' },
        { name: 'AudioWorkletNode', message: 'AudioEngine 구현체 내부에서만 사용한다 (spec §4.1)' }
      ]
    }
  },
  eslintConfigPrettier
)
