/**
 * 阅读设置面板：主题 / 字号 / 行高 / 字体 / 页边距 / 翻页方式 / 单双页 / 两端对齐。
 * 改动立即生效（写进 BookState.settings 并防抖持久化）。
 */
import * as React from 'react';
import {
  READER_FONT_LABELS,
  READER_THEMES,
  READER_THEME_IDS,
  UI_SETTING_DEFAULTS,
} from './theme.js';
import { IconClose, IconSettings } from './icons.js';

const h = React.createElement;

/**
 * 阅读设置面板。
 * @param {object} props
 * @param {object} props.ui 控制器
 * @returns {React.ReactElement}
 */
export function SettingsPanel({ ui }) {
  const bookId = ui.useSel((state) => state.bookId);
  ui.useSel((state) => (state.states || {})[bookId] || null);
  const isLoaded = !!ui.useSel((state) => ((state.states || {})[bookId] ? 1 : 0));

  React.useEffect(() => {
    if (bookId != null) ui.loadState(bookId);
  }, [bookId, ui]);

  const settings = ui.settingsOf(bookId);
  const update = (patch) => ui.updateSettings(bookId, patch);

  const themeCards = READER_THEME_IDS.map((id) => {
    const theme = READER_THEMES[id];
    return h(
      'button',
      {
        key: id,
        type: 'button',
        className: `qmr-theme-card${settings.theme === id ? ' is-active' : ''}`,
        'aria-pressed': settings.theme === id,
        onClick: () => update({ theme: id }),
      },
      h('span', {
        className: 'qmr-theme-swatch',
        style: { background: theme.bg, color: theme.text },
        'aria-hidden': 'true',
      }, '文'),
      h('span', null, id === 'white' ? ui.t('themeWhite', theme.label) : theme.label),
    );
  });

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'qmr-panel-head' },
      h(IconSettings, { width: 16, height: 16 }),
      h('span', { className: 'qmr-panel-title' }, '阅读设置'),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '关闭设置',
        onClick: () => ui.setPanel(null),
      }, h(IconClose, { width: 16, height: 16 })),
    ),
    h(
      'div',
      { className: 'qmr-panel-body' },
      !isLoaded ? h('div', { className: 'qmr-muted qmr-small', style: { marginBottom: 8 } }, '正在读取已保存的设置…') : null,

      h('div', { className: 'qmr-group-title' }, '主题'),
      h('div', { className: 'qmr-theme-grid' }, themeCards),

      h('div', { className: 'qmr-group-title' }, '排版'),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '字号'),
        h('span', { className: 'qmr-field-ctl' },
          h('input', {
            className: 'qmr-range',
            type: 'range',
            min: 14,
            max: 28,
            step: 1,
            value: settings.fontSize,
            'aria-label': '字号',
            onChange: (event) => update({ fontSize: Number(event.target.value) }),
          })),
        h('span', { className: 'qmr-field-value' }, `${settings.fontSize}px`),
      ),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '行高'),
        h('span', { className: 'qmr-field-ctl' },
          h('input', {
            className: 'qmr-range',
            type: 'range',
            min: 1.4,
            max: 2.2,
            step: 0.05,
            value: settings.lineHeight,
            'aria-label': '行高',
            onChange: (event) => update({ lineHeight: Number(event.target.value) }),
          })),
        h('span', { className: 'qmr-field-value' }, Number(settings.lineHeight).toFixed(2)),
      ),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '字体'),
        h('span', { className: 'qmr-field-ctl' },
          h('select', {
            className: 'qmr-select',
            style: { flex: '1 1 auto' },
            value: settings.fontFamily,
            'aria-label': '字体',
            onChange: (event) => update({ fontFamily: event.target.value }),
          }, Object.keys(READER_FONT_LABELS).map((key) =>
            h('option', { key, value: key }, READER_FONT_LABELS[key])))),
      ),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '页边距'),
        h('span', { className: 'qmr-field-ctl' },
          h('input', {
            className: 'qmr-range',
            type: 'range',
            min: 32,
            max: 120,
            step: 4,
            value: settings.margin,
            'aria-label': '页边距',
            onChange: (event) => update({ margin: Number(event.target.value) }),
          })),
        h('span', { className: 'qmr-field-value' }, `${settings.margin}px`),
      ),

      h('div', { className: 'qmr-group-title' }, '翻页'),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '方式'),
        h('span', { className: 'qmr-field-ctl' },
          h(
            'span',
            { className: 'qmr-seg', role: 'group', 'aria-label': '翻页方式' },
            h('button', {
              type: 'button',
              className: settings.flow === 'paginated' ? 'is-active' : '',
              'aria-pressed': settings.flow === 'paginated',
              onClick: () => update({ flow: 'paginated' }),
            }, '分页'),
            h('button', {
              type: 'button',
              className: settings.flow === 'scroll' ? 'is-active' : '',
              'aria-pressed': settings.flow === 'scroll',
              onClick: () => update({ flow: 'scroll' }),
            }, '连续滚动'),
          )),
      ),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '版式'),
        h('span', { className: 'qmr-field-ctl' },
          h('label', { className: 'qmr-switch' },
            h('input', {
              type: 'checkbox',
              checked: settings.spread,
              disabled: settings.flow !== 'paginated',
              'aria-label': '双页布局',
              onChange: (event) => update({ spread: !!event.target.checked }),
            }),
            '双页（宽屏时左右并排）')),
      ),
      h(
        'div',
        { className: 'qmr-field' },
        h('span', { className: 'qmr-field-label' }, '对齐'),
        h('span', { className: 'qmr-field-ctl' },
          h('label', { className: 'qmr-switch' },
            h('input', {
              type: 'checkbox',
              checked: settings.justify,
              'aria-label': '两端对齐',
              onChange: (event) => update({ justify: !!event.target.checked }),
            }),
            '两端对齐')),
      ),

      h('div', { className: 'qmr-divider' }),
      h(
        'div',
        { className: 'qmr-hl-tools' },
        h('button', {
          type: 'button',
          className: 'qmr-btn qmr-btn-sm',
          onClick: () => update({ ...UI_SETTING_DEFAULTS }),
        }, '恢复默认'),
      ),
      h('p', { className: 'qmr-muted qmr-small', style: { marginTop: 10 } },
        '主题应用于书页、阅读工具栏与 AI 伴读；设置随这本书保存。'),
    ),
  );
}