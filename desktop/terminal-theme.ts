import type { ITheme } from '@xterm/xterm';

export function readTerminalTheme(): ITheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const light = root.dataset.theme === 'white';
  return {
    background: token('--bg-color'),
    foreground: token('--text-primary'),
    cursor: token('--accent-color'),
    cursorAccent: token('--bg-color'),
    selectionBackground: `rgba(${token('--accent-rgb')}, ${light ? '0.22' : '0.3'})`,
    black: light ? '#17212b' : '#37414b',
    red: light ? '#b52b35' : '#ef7b83',
    green: light ? '#22713d' : '#79c98e',
    yellow: light ? '#806000' : '#e9ba65',
    blue: light ? '#205fae' : '#8cb8ed',
    magenta: light ? '#8643a1' : '#c89ee6',
    cyan: light ? '#006d80' : '#5fd9e8',
    white: light ? '#65717d' : '#d5dce3',
    brightBlack: light ? '#626e7b' : '#939da7',
    brightRed: light ? '#a71f2b' : '#ff9da3',
    brightGreen: light ? '#176432' : '#a1e0b1',
    brightYellow: light ? '#755600' : '#f4d18c',
    brightBlue: light ? '#174f99' : '#b0d1ff',
    brightMagenta: light ? '#783393' : '#dfb9f5',
    brightCyan: light ? '#005c70' : '#97e7ef',
    brightWhite: light ? '#475461' : '#f1f2f2',
  };
}
