/**
 * dsh-plan-guard Client half: the "Guarded context" drawer as a right-sidebar
 * tab, backed by the `plan-guard` Host Remote namespace and a self-refreshing
 * `dsh-resource://plan-guard-drawer/<sessionId>` resource.
 *
 * Plain-JS UI plugin (window.__ModuleLoader__ module): React comes from the
 * browser module table; behavior reaches the components through the inject
 * face, never through ctx.
 * @module dsh-plan-guard/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plan-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Optional platform modules: a specifier the page module table does not
     * seed degrades the drawer instead of failing the whole Client entry
     * (the 0.2.2 `zod` lesson). Every shipped sidebar bundle already resolves
     * both of these, so in practice they are present.
     */
    const optionalRequire = (specifier) => {
      try { return require(specifier) } catch (_error) { return undefined }
    }
    const Primitives = optionalRequire('@deepseek-ai/dsh-client-ui-primitives')
    const WorkspacePath = optionalRequire('@deepseek-ai/dsh-util-workspace-path')
    // NB: MarkdownText is a React.memo object, not a plain function.
    const MarkdownText = Primitives !== undefined && Primitives !== null
      && Primitives.MarkdownText !== undefined && Primitives.MarkdownText !== null
      ? Primitives.MarkdownText
      : undefined
    const fileAddressFor = WorkspacePath !== undefined && typeof WorkspacePath.fileAddressFor === 'function'
      ? WorkspacePath.fileAddressFor
      : undefined

    const PLUGIN_ID = 'dsh-plan-guard'
    const TAB_KIND = 'plan-guard-drawer'
    const LOCALE_NS = 'plan-guard'
    const REMOTE_NS = 'plan-guard'

    const POLICY_OPTIONS = [
      { value: 'ask', key: 'policy.ask' },
      { value: 'allow-mount', key: 'policy.allowMount' },
      { value: 'allow-unmount', key: 'policy.allowUnmount' },
      { value: 'allow-all', key: 'policy.allowAll' },
      { value: 'deny-all', key: 'policy.denyAll' },
    ]

    /** UI copy; the plugin manager additionally reads locale/*.json meta from disk. */
    const DICTS = {
      en: {
        'meta.title': 'Guarded context',
        'meta.description': 'Pin plans, notes, and files so they stay model-visible after context compaction.',
        'drawer.title': 'Guarded context',
        'drawer.tabTitle': 'Guarded',
        'guide.title': 'Guarded context',
        'guide.description': 'Open the guarded-context drawer for this Session.',
        'common.loading': 'Loading…',
        'common.failed': 'Guarded context failed to load.',
        'common.unavailable': 'This Session is not live in the Host. Resume it to manage guarded context.',
        'policy.label': 'Model permission',
        'policy.ask': 'Ask every time',
        'policy.allowMount': 'Allow mounting',
        'policy.allowUnmount': 'Allow unmounting',
        'policy.allowAll': 'Allow everything',
        'policy.denyAll': 'Do not allow',
        'plans.section': 'Plans',
        'plans.empty': 'No plans yet.',
        'plans.auto': 'Auto',
        'plans.awaiting': 'Auto after first compaction',
        'plans.followAuto': 'Follow auto',
        'plans.explicitMounted': 'Mounted by you',
        'plans.explicitUnmounted': 'Unmounted by you',
        'plans.notAuto': 'Not auto-mounted',
        'plans.rejected': 'Rejected',
        'plans.size': '{chars} chars',
        'plans.mountHint': 'Mount this plan',
        'plans.unmountHint': 'Unmount this plan',
        'plans.expand': 'Show plan',
        'plans.collapse': 'Hide plan',
        'items.section': 'Pinned items',
        'items.kindFile': 'File',
        'items.kindNote': 'Note',
        'items.expand': 'Show content',
        'items.collapse': 'Hide content',
        'items.empty': 'Nothing pinned yet.',
        'items.limit': '{count} of {max} items',
        'items.mounted': 'Mounted',
        'items.unmounted': 'Unmounted',
        'items.locked': 'Locked',
        'items.unlocked': 'Unlocked',
        'items.lock': 'Lock',
        'items.unlock': 'Unlock',
        'items.delete': 'Delete',
        'items.deleteConfirm': 'Confirm delete',
        'items.cancel': 'Cancel',
        'items.addedByHuman': 'human',
        'items.addedByModel': 'model',
        'items.meta': '{kind} · {state} · {by} · {size} chars',
        'items.mountHint': 'Mount this item',
        'items.unmountHint': 'Unmount this item',
        'items.contentError': 'This content could not be read:',
        'items.openViewer': 'Open in viewer',
        'markdown.copy': 'Copy',
        'markdown.copied': 'Copied',
        'markdown.footnotes': 'Footnotes',
        'add.note': 'Add note',
        'add.file': 'Add file',
        'add.noteTitle': 'Title',
        'add.noteText': 'Note',
        'add.filePath': 'Workspace path',
        'add.submit': 'Add and mount',
        'add.cancel': 'Cancel',
        'add.titlePlaceholder': 'Optional title',
        'add.notePlaceholder': 'An important constraint that should survive compaction…',
        'add.filePlaceholder': 'src/important.md',
        'content.loading': 'Loading content…',
        'content.failed': 'Content failed to load.',
        'content.truncated': 'truncated',
        'content.unavailable': 'No content.',
        'preview.label': 'Preview',
        'preview.collapse': 'Collapse',
        'row.error': 'The change failed:',
      },
      zh: {
        'meta.title': '上下文守护',
        'meta.description': '守护计划、备注与文件，让它们在上下文压缩后继续可见。',
        'drawer.title': '上下文守护',
        'drawer.tabTitle': '守护',
        'guide.title': '上下文守护',
        'guide.description': '打开当前会话的守护上下文抽屉。',
        'common.loading': '正在加载……',
        'common.failed': '守护上下文加载失败。',
        'common.unavailable': '该会话当前不在宿主中运行。恢复会话后即可管理守护上下文。',
        'policy.label': '模型权限',
        'policy.ask': '每次询问',
        'policy.allowMount': '允许挂载',
        'policy.allowUnmount': '允许卸载',
        'policy.allowAll': '允许全部',
        'policy.denyAll': '不允许',
        'plans.section': '计划',
        'plans.empty': '还没有计划。',
        'plans.auto': '自动',
        'plans.awaiting': '首次压缩后自动挂载',
        'plans.followAuto': '恢复自动',
        'plans.explicitMounted': '由你挂载',
        'plans.explicitUnmounted': '由你卸下',
        'plans.notAuto': '不自动挂载',
        'plans.rejected': '已拒绝',
        'plans.size': '{chars} 字符',
        'plans.mountHint': '挂载这份计划',
        'plans.unmountHint': '卸下这份计划',
        'plans.expand': '展开计划',
        'plans.collapse': '收起计划',
        'items.section': '已固定条目',
        'items.kindFile': '文件',
        'items.kindNote': '备注',
        'items.expand': '展开内容',
        'items.collapse': '收起内容',
        'items.empty': '还没有固定任何内容。',
        'items.limit': '{count}/{max} 条',
        'items.mounted': '已挂载',
        'items.unmounted': '未挂载',
        'items.locked': '已锁定',
        'items.unlocked': '未锁定',
        'items.lock': '锁定',
        'items.unlock': '解锁',
        'items.delete': '删除',
        'items.deleteConfirm': '确认删除',
        'items.cancel': '取消',
        'items.addedByHuman': '人类',
        'items.addedByModel': '模型',
        'items.meta': '{kind} · {state} · {by} · {size} 字符',
        'items.mountHint': '挂载这个条目',
        'items.unmountHint': '卸载这个条目',
        'items.contentError': '无法读取该内容：',
        'items.openViewer': '在阅览器中打开',
        'markdown.copy': '复制',
        'markdown.copied': '已复制',
        'markdown.footnotes': '脚注',
        'add.note': '添加备注',
        'add.file': '添加文件',
        'add.noteTitle': '标题',
        'add.noteText': '备注',
        'add.filePath': '工作区路径',
        'add.submit': '添加并挂载',
        'add.cancel': '取消',
        'add.titlePlaceholder': '可选标题',
        'add.notePlaceholder': '一条需要在压缩后继续保留的重要约束……',
        'add.filePlaceholder': 'src/important.md',
        'content.loading': '正在读取内容……',
        'content.failed': '内容加载失败。',
        'content.truncated': '已截断',
        'content.unavailable': '没有可显示的内容。',
        'preview.label': '预览',
        'preview.collapse': '收起',
        'row.error': '修改失败：',
      },
    }

    /**
     * Drawer stylesheet, installed once per page. Every color, radius and font
     * comes from the live theme tokens, so light and dark both follow the host;
     * literal values appear only as fallbacks for a token a theme omits.
     */
    const CSS = String.raw`
.pg-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  /* The host tab body is height:100% with overflow:hidden, so the tab content
  owns its scrolling (same recipe as the files tab: fill, shrink, native
  scrollbar with a stable gutter). Without this the pane clips and no
  scrollbar ever appears. */
  flex: auto;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 12px 14px 24px;
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13);
}
.pg-caption {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxxs-11);
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.pg-count {
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12);
  white-space: nowrap;
}
.pg-policy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.pg-policyMenu {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 62%;
}
.pg-menuTrigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  min-width: 0;
  max-width: 100%;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
}
.pg-menuTrigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.pg-menuTrigger:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
.pg-menuTriggerLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pg-menuTriggerIcon {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-caption);
}
.pg-menuTriggerIcon svg {
  width: 14px;
  height: 14px;
  transition: transform .12s;
}
.pg-menuTriggerIconOpen svg {
  transform: rotate(180deg);
}
.pg-menuList {
  box-sizing: border-box;
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  min-width: 144px;
  max-width: 100%;
  padding: 4px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-1));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
}
.pg-menuItem {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.pg-menuItem:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.pg-menuItem:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.pg-menuItem:disabled {
  opacity: .4;
  cursor: not-allowed;
}
.pg-menuItemLabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pg-menuCheck {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--dsw-alias-label-primary, inherit);
}
.pg-menuTrigger:focus-visible,
.pg-input:focus-visible,
.pg-textarea:focus-visible,
.pg-title:focus-visible,
.pg-btn:focus-visible,
.pg-switch:focus-visible,
.pg-previewToggle:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.pg-previewToggle:focus-visible {
  /* The preview panel clips its corners, so keep the ring inside the header. */
  outline-offset: -2px;
}
.pg-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.pg-sectionHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.pg-card {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-1);
}
.pg-card:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.pg-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.pg-entry {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.pg-entryExpanded > .pg-card {
  border-color: var(--dsw-alias-border-l2);
}
.pg-title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.pg-titleText {
  flex: 1;
  min-width: 0;
}
.pg-titleChevron {
  display: inline-flex;
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.pg-titleChevron svg {
  width: 12px;
  height: 12px;
  transition: transform .12s;
}
.pg-titleChevronOpen svg {
  transform: rotate(180deg);
}
.pg-meta {
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12);
}
.pg-path {
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-all;
}
.pg-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.pg-btn {
  box-sizing: border-box;
  height: 26px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  cursor: pointer;
}
.pg-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary, inherit);
}
.pg-btn:disabled {
  opacity: .5;
  cursor: default;
}
.pg-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.pg-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.pg-btn-danger {
  color: var(--dsw-alias-state-error-primary, #b45353);
}
.pg-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary, #b45353);
}
.pg-switch {
  position: relative;
  flex: 0 0 auto;
  width: 32px;
  height: 18px;
  margin: 2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3, rgba(127,127,127,.45));
  cursor: pointer;
  transition: background-color .12s;
}
.pg-switch[aria-checked="true"] {
  background: var(--dsw-alias-state-business-primary);
}
.pg-switch:disabled {
  opacity: .5;
  cursor: default;
}
.pg-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--dsw-static-neutral-bluish-00, #fff);
  transition: transform .12s;
}
.pg-switch[aria-checked="true"] .pg-knob {
  transform: translateX(14px);
}
.pg-doc {
  margin: 0;
  max-height: 320px;
  padding: 8px 10px;
  overflow: auto;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary, inherit);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.pg-preview {
  box-sizing: border-box;
  min-width: 0;
  border: .5px solid var(--dsw-alias-border-l2);
  border-left: 2px solid var(--dsw-alias-state-business-primary);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
}
.pg-previewHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 2px 6px 2px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.pg-previewLabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, inherit);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pg-previewMeta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12);
  white-space: nowrap;
}
.pg-previewToggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.pg-previewToggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary, inherit);
}
.pg-previewToggle svg {
  width: 12px;
  height: 12px;
}
.pg-previewBody {
  padding: 10px 12px;
  max-height: 360px;
  overflow: auto;
  scrollbar-gutter: stable;
  color: var(--dsw-alias-label-primary, inherit);
}
/* The reader typography is tuned for full-width documents; trim its vertical
   rhythm for the narrow preview pane while keeping headings and links. */
.pg-preview .pg-previewBody :where(p, ul, ol, blockquote) {
  margin: 8px 0;
}
.pg-preview .pg-previewBody :where(h1, h2, h3, h4, h5, h6) {
  margin: 14px 0 6px;
}
.pg-preview .pg-previewBody > :first-child {
  margin-top: 0;
}
.pg-preview .pg-previewBody > :last-child {
  margin-bottom: 0;
}
/* The fallback already sits inside the panel, so drop its double frame. */
.pg-preview .pg-doc {
  margin: 0;
  max-height: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}
.pg-form {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-1);
}
.pg-input,
.pg-textarea {
  box-sizing: border-box;
  width: 100%;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  padding: 0 10px;
}
.pg-input {
  height: 28px;
}
.pg-textarea {
  min-height: 72px;
  padding: 6px 10px;
  resize: vertical;
}
.pg-input::placeholder,
.pg-textarea::placeholder {
  color: var(--dsw-alias-label-dimmed, inherit);
}
.pg-input:focus,
.pg-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary);
  outline: none;
}
.pg-empty {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12);
}
.pg-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary, #b45353);
  font: var(--dsw-font-xxs-12);
  white-space: pre-wrap;
}
@media (prefers-reduced-motion: reduce) {
  .pg-switch,
  .pg-knob,
  .pg-titleChevron svg {
    transition: none;
  }
}
`

    /** Install the drawer stylesheet once per page; the disposer removes it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plan-guard]') !== null) return () => {}
      const element = document.createElement('style')
      element.setAttribute('data-plan-guard', '')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /** Tab glyph: a document with a check, drawn in the chip's own color. */
    function GuardedIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('rect', { x: 2.5, y: 1.5, width: 7.5, height: 13, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.1 }),
      h('path', {
        d: 'M4.5 5h3.5M4.5 7.5h3.5M4.5 10h2',
        stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M9.5 11.2l1.7 1.8 2.8-3.4',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

    const RESOURCE_SCHEME = 'dsh-resource://'

    /** The one drawer resource address for a session. */
    const drawerAddress = (sessionId) => `${RESOURCE_SCHEME}${TAB_KIND}/${encodeURIComponent(sessionId)}`

    const sessionIdOfAddress = (address) => {
      const prefix = `${RESOURCE_SCHEME}${TAB_KIND}/`
      if (typeof address !== 'string' || !address.startsWith(prefix)) return undefined
      try { return decodeURIComponent(address.slice(prefix.length)) } catch (_error) { return undefined }
    }

    /** A resource frame may be the raw RemoteResult or its already-unwrapped value. */
    const unwrapFrame = (value) => (isRecord(value) && value.ok === true && isRecord(value.value) ? value.value : value)

    /** The drawer resource: list once, then refresh on a fixed interval until released. */
    function openDrawerResource(remote, address, { signal }) {
      const sessionId = sessionIdOfAddress(address)
      if (sessionId === undefined) {
        return (async function* once() {
          yield { ok: false, error: { code: 'malformed', message: `plan-guard drawer address "${address}" names no session` } }
        })()
      }
      return (async function* polling() {
        const wait = (ms) => new Promise((resolve) => {
          const timer = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        while (!signal.aborted) {
          let frame
          try {
            const result = await remote.list(sessionId)
            frame = result?.ok === true ? result : { ok: false, error: result?.error ?? { code: 'carrier', message: 'list failed' } }
          } catch (error) {
            frame = { ok: false, error: { code: 'carrier', message: String(error) } }
          }
          yield frame
          await wait(3000)
        }
      })()
    }

    // The browser module table seeds React but not zod. Strict codecs therefore
    // carry small hand-written parsers: the Client only checks mode, typeSymbol,
    // and create when mounting, while the Host validates arguments against its
    // own descriptors. Keeping create() honest costs little and avoids a
    // client-only dependency that cannot be resolved at runtime.
    const strictCodec = (typeSymbol, jsonSchema, schema) => ({
      mode: 'strict',
      typeSymbol,
      jsonSchema,
      create: () => schema,
    })
    const stringCodec = (minLength) => strictCodec(
      'dsh-plan-guard#String',
      minLength > 0 ? { type: 'string', minLength } : { type: 'string' },
      {
        parse(value) {
          if (typeof value !== 'string' || value.length < minLength) {
            throw new Error(`expected a string with at least ${minLength} character(s)`)
          }
          return value
        },
      },
    )
    const booleanCodec = strictCodec(
      'dsh-plan-guard#Boolean',
      { type: 'boolean' },
      {
        parse(value) {
          if (typeof value !== 'boolean') throw new Error('expected a boolean')
          return value
        },
      },
    )
    const enumCodec = (values) => strictCodec(
      'dsh-plan-guard#Policy',
      { type: 'string', enum: values },
      {
        parse(value) {
          if (!values.includes(value)) throw new Error(`expected one of ${values.join(', ')}`)
          return value
        },
      },
    )
    const resultCodec = strictCodec(
      'dsh-plan-guard#Result',
      {},
      { parse: (value) => value },
    )

    const stringParameter = (name, minLength = 1) => ({
      name, wire: name, source: 'json', codec: stringCodec(minLength),
    })
    const plainStringParameter = (name) => ({
      name, wire: name, source: 'json', codec: stringCodec(0),
    })
    const booleanParameter = (name) => ({
      name, wire: name, source: 'json', codec: booleanCodec,
    })
    const enumParameter = (name, values) => ({
      name, wire: name, source: 'json', codec: enumCodec(values),
    })
    const remoteMethod = (method, parameters) => ({
      id: `${PLUGIN_ID}/plan-guard#${method}`,
      service: REMOTE_NS,
      namespace: REMOTE_NS,
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: resultCodec,
    })
    const remoteContribution = {
      package: PLUGIN_ID,
      descriptors: [
        remoteMethod('list', [stringParameter('sessionId')]),
        remoteMethod('setPolicy', [stringParameter('sessionId'), enumParameter('policy', ['ask', 'allow-mount', 'allow-unmount', 'allow-all', 'deny-all'])]),
        remoteMethod('setPlan', [stringParameter('sessionId'), stringParameter('callId'), enumParameter('choice', ['mounted', 'unmounted', 'auto'])]),
        remoteMethod('addNote', [stringParameter('sessionId'), plainStringParameter('title'), stringParameter('text')]),
        remoteMethod('addFile', [stringParameter('sessionId'), stringParameter('path')]),
        remoteMethod('setMounted', [stringParameter('sessionId'), stringParameter('itemId'), booleanParameter('mounted')]),
        remoteMethod('setLock', [stringParameter('sessionId'), stringParameter('itemId'), booleanParameter('locked')]),
        remoteMethod('removeItem', [stringParameter('sessionId'), stringParameter('itemId')]),
        remoteMethod('content', [stringParameter('sessionId'), stringParameter('id')]),
      ],
    }

    /** Chevron-down and check glyphs, drawn in the row's own color. */
    function ChevronDownIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.5 5.25L7 8.75L10.5 5.25',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function ChevronUpIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.5 8.75L7 5.25L10.5 8.75',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function CheckIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', className: 'pg-menuCheck' },
        h('path', {
          d: 'M2.8 7.4l2.8 2.8 5.6-6.4',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /**
     * Policy picker as a custom menu. A native `<select>` popup is rendered by
     * the OS and cannot be styled; this popup follows the harness Menu recipe
     * (card, hover fill, trailing check) through the same `--dsw-*` tokens.
     * Arrow keys move real focus between rows, like the native menu.
     */
    function PolicyMenu({ policy, busy, onSelect, t }) {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const itemRefs = React.useRef([])

      React.useEffect(() => {
        if (open !== true) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root !== null && root !== undefined && typeof root.contains === 'function'
            && !root.contains(event.target)) {
            setOpen(false)
          }
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            const trigger = triggerRef.current
            if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') {
              trigger.focus()
            }
          }
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const focusItem = (index) => {
        const count = POLICY_OPTIONS.length
        const wrapped = ((index % count) + count) % count
        const node = itemRefs.current[wrapped]
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }
      const onItemKeyDown = (event, index) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(index + 1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(index - 1) }
        else if (event.key === 'Home') { event.preventDefault(); focusItem(0) }
        else if (event.key === 'End') { event.preventDefault(); focusItem(POLICY_OPTIONS.length - 1) }
      }
      const choose = (value) => {
        setOpen(false)
        if (value !== policy) onSelect(value)
      }
      const current = POLICY_OPTIONS.find(option => option.value === policy) ?? POLICY_OPTIONS[0]
      return h('div', { className: 'pg-policyMenu', ref: rootRef },
        h('button', {
          type: 'button', ref: triggerRef, className: 'pg-menuTrigger',
          disabled: busy === true, 'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-label': t('policy.label'),
          onClick: () => setOpen(!open),
          onKeyDown: (event) => {
            if ((event.key === 'ArrowDown' || event.key === 'Enter') && open !== true) {
              event.preventDefault()
              setOpen(true)
            }
          },
        },
        h('span', { className: 'pg-menuTriggerLabel' }, t(current.key)),
        h('span', { className: 'pg-menuTriggerIcon' + (open === true ? ' pg-menuTriggerIconOpen' : '') }, h(ChevronDownIcon, null))),
        open !== true ? null : h('div', { className: 'pg-menuList', role: 'menu', 'aria-label': t('policy.label') },
          POLICY_OPTIONS.map((option, index) => h('button', {
            type: 'button', key: option.value, role: 'menuitem',
            className: 'pg-menuItem', disabled: busy === true,
            ref: (node) => { itemRefs.current[index] = node },
            onClick: () => choose(option.value),
            onKeyDown: (event) => onItemKeyDown(event, index),
          },
          h('span', { className: 'pg-menuItemLabel' }, t(option.key)),
          option.value === policy ? h(CheckIcon, null) : null)))
      )
    }

    /** Accessible switch; the framework owns colors through the stylesheet. */
    function Switch({ checked, busy, label, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
        disabled: busy === true, className: 'pg-switch',
        onClick: () => { if (busy !== true) onChange(!checked) },
      }, h('span', { className: 'pg-knob' }))
    }

    function PlanRow({ plan, busy, expanded, preview, titleRef, onToggle, onAuto, onExpand, t }) {
      let stateLabel
      if (plan.explicit === 'mounted') stateLabel = t('plans.explicitMounted')
      else if (plan.explicit === 'unmounted') stateLabel = t('plans.explicitUnmounted')
      else if (plan.auto) stateLabel = t('plans.auto')
      else if (plan.awaitingCompaction) stateLabel = t('plans.awaiting')
      else stateLabel = t('plans.notAuto')
      const meta = [
        stateLabel,
        plan.accepted === false ? t('plans.rejected') : undefined,
        t('plans.size').replace('{chars}', String(plan.size)),
        typeof plan.turn === 'number' ? 'turn ' + String(plan.turn) : undefined,
      ].filter(part => typeof part === 'string' && part !== '').join(' · ')
      return h('div', { className: 'pg-entry' + (expanded === true ? ' pg-entryExpanded' : '') },
        h('div', { className: 'pg-card' },
          h(Switch, {
            checked: plan.mounted, busy,
            label: t(plan.mounted ? 'plans.unmountHint' : 'plans.mountHint'),
            onChange: onToggle,
          }),
          h('div', { className: 'pg-body' },
            h('button', {
              type: 'button', className: 'pg-title', ref: titleRef,
              'aria-expanded': expanded === true,
              title: t(expanded ? 'plans.collapse' : 'plans.expand'),
              onClick: onExpand,
            },
            h('span', { className: 'pg-titleText' }, plan.title),
            h('span', {
              className: 'pg-titleChevron' + (expanded === true ? ' pg-titleChevronOpen' : ''),
              'aria-hidden': 'true',
            }, h(ChevronDownIcon, null))),
            h('div', { className: 'pg-meta' }, meta),
            plan.explicit !== null && plan.autoEligible
              ? h('div', { className: 'pg-actions' },
                h('button', { type: 'button', className: 'pg-btn', disabled: busy, onClick: onAuto }, t('plans.followAuto')))
              : null,
          ),
        ),
        preview === undefined ? null : preview,
      )
    }

    function ItemRow({ item, busy, expanded, preview, titleRef, deleteConfirm, onToggle, onLock, onDelete, onConfirmDelete, onCancelDelete, onExpand, onOpenViewer, t }) {
      const stateLabel = item.mounted ? t('items.mounted') : t('items.unmounted')
      const meta = t('items.meta')
        .replace('{kind}', item.kind === 'file' ? t('items.kindFile') : t('items.kindNote'))
        .replace('{state}', item.locked ? stateLabel + ' · ' + t('items.locked') : stateLabel)
        .replace('{by}', item.createdBy === 'human' ? t('items.addedByHuman') : t('items.addedByModel'))
        .replace('{size}', String(item.size))
      return h('div', { className: 'pg-entry' + (expanded === true ? ' pg-entryExpanded' : '') },
        h('div', { className: 'pg-card' },
          h(Switch, {
            checked: item.mounted, busy,
            label: t(item.mounted ? 'items.unmountHint' : 'items.mountHint'),
            onChange: onToggle,
          }),
          h('div', { className: 'pg-body' },
            h('button', {
              type: 'button', className: 'pg-title', ref: titleRef,
              'aria-expanded': expanded === true,
              title: t(expanded ? 'items.collapse' : 'items.expand'),
              onClick: onExpand,
            },
            h('span', { className: 'pg-titleText' }, item.title),
            h('span', {
              className: 'pg-titleChevron' + (expanded === true ? ' pg-titleChevronOpen' : ''),
              'aria-hidden': 'true',
            }, h(ChevronDownIcon, null))),
            item.kind === 'file' && item.path !== null ? h('div', { className: 'pg-path' }, item.path) : null,
            h('div', { className: 'pg-meta' }, meta),
            h('div', { className: 'pg-actions' },
              h('button', {
                type: 'button', className: 'pg-btn', disabled: busy,
                'aria-pressed': item.locked,
                onClick: () => onLock(!item.locked),
              }, item.locked ? t('items.unlock') : t('items.lock')),
              onOpenViewer === undefined ? null : h('button', {
                type: 'button', className: 'pg-btn', disabled: busy,
                onClick: onOpenViewer,
              }, t('items.openViewer')),
              deleteConfirm
                ? h(React.Fragment, null,
                  h('button', { type: 'button', className: 'pg-btn pg-btn-danger', disabled: busy, onClick: onConfirmDelete }, t('items.deleteConfirm')),
                  h('button', { type: 'button', className: 'pg-btn', disabled: busy, onClick: onCancelDelete }, t('items.cancel')))
                : h('button', { type: 'button', className: 'pg-btn pg-btn-danger', disabled: busy, onClick: onDelete }, t('items.delete')),
            ),
          ),
        ),
        preview === undefined ? null : preview,
      )
    }

    function ContentBlock({ content, t, markdown, onCollapse }) {
      let body
      let meta
      if (content === undefined || content.status === 'loading') {
        body = h('p', { className: 'pg-empty' }, t('content.loading'))
      } else if (content.status === 'failed') {
        body = h('p', { className: 'pg-error' }, `${t('content.failed')} ${content.error ?? ''}`)
      } else {
        const value = content.value
        if (!isRecord(value)) {
          body = h('p', { className: 'pg-empty' }, t('content.unavailable'))
        } else if (value.error !== null && value.error !== undefined) {
          body = h('p', { className: 'pg-error' }, `${t('items.contentError')} ${value.error}`)
        } else {
          if (value.truncated === true) meta = t('content.truncated')
          const text = String(value.text ?? '')
          // The shared GFM renderer the built-in document viewer uses, at its
          // default reading size (the compact variant is a dim hint style).
          body = markdown !== undefined && text !== ''
            ? h(markdown.Text, { text, streaming: false, labels: markdown.labels })
            : h('pre', { className: 'pg-doc' }, text)
        }
      }
      return h('div', { className: 'pg-preview' },
        h('div', { className: 'pg-previewHead' },
          h('span', { className: 'pg-previewLabel' }, t('preview.label')),
          meta === undefined ? null : h('span', { className: 'pg-previewMeta' }, meta),
          h('button', {
            type: 'button', className: 'pg-previewToggle',
            title: t('preview.collapse'), onClick: onCollapse,
          }, t('preview.collapse'), h(ChevronUpIcon, null)),
        ),
        h('div', { className: 'pg-previewBody' }, body),
      )
    }

    /** The drawer body: permission mode, plans, items, add forms, previews. */
    function Drawer(props) {
      const { sessionId, useResource, t, api, useTabInfo } = props
      const resource = useResource(drawerAddress(sessionId))
      const [state, setState] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [expanded, setExpanded] = React.useState(undefined)
      const [content, setContent] = React.useState(undefined)
      const [addKind, setAddKind] = React.useState(undefined)
      const [noteTitle, setNoteTitle] = React.useState('')
      const [noteText, setNoteText] = React.useState('')
      const [filePath, setFilePath] = React.useState('')
      const [deleteConfirm, setDeleteConfirm] = React.useState(undefined)
      const titleRefs = React.useRef(new Map())
      const contentRequest = React.useRef(0)

      // The shared markdown chrome, memoized per locale: MarkdownText keeps a
      // streaming render cache keyed off the labels identity.
      const markdown = React.useMemo(() => (
        MarkdownText === undefined
          ? undefined
          : {
              Text: MarkdownText,
              labels: {
                code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
                footnotes: t('markdown.footnotes'),
              },
            }
      ), [t])

      // The tab slot hands every body a `useTabInfo` hook (same as FilesBody); its
      // `tab.actions.openResource` lands a file address in the built-in
      // document viewer. Without the hook or the address helper there is no
      // viewer button, only the inline preview.
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const viewerOpen = tabInfo !== undefined && tabInfo.tab !== undefined && tabInfo.tab.actions !== undefined
        && typeof tabInfo.tab.actions.openResource === 'function' && fileAddressFor !== undefined
        ? tabInfo.tab.actions.openResource.bind(tabInfo.tab.actions)
        : undefined
      const openInViewer = viewerOpen === undefined
        ? undefined
        : (path) => { viewerOpen(fileAddressFor(sessionId, undefined, path)) }

      React.useEffect(() => {
        if (resource.status === 'live') setState(unwrapFrame(resource.value))
      }, [resource.status, resource.value])

      const callRemote = async (operation) => {
        const result = await operation()
        if (result?.ok !== true) {
          const reason = result?.error?.message ?? result?.error?.code ?? 'Remote call failed'
          throw new Error(String(reason))
        }
        return result.value
      }

      const run = async (key, operation) => {
        setBusy(key)
        setError(undefined)
        try {
          const value = await callRemote(operation)
          if (isRecord(value) && 'live' in value) setState(value)
          return { ok: true, value }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return { ok: false }
        } finally {
          setBusy(undefined)
        }
      }

      // Expanding swaps the single open preview; collapsing puts focus back on
      // the row title so the panel's own button does not strand keyboard users.
      const attachTitle = (id) => (node) => {
        if (node === null || node === undefined) titleRefs.current.delete(id)
        else titleRefs.current.set(id, node)
      }

      const collapse = (id) => {
        // Invalidate an in-flight content read so a late response cannot
        // repaint the panel or clobber the next row's content.
        contentRequest.current += 1
        setExpanded(undefined)
        setContent(undefined)
        const title = titleRefs.current.get(id)
        if (title !== null && title !== undefined && typeof title.focus === 'function') title.focus()
      }

      const previewFor = (id) => {
        if (expanded !== id) return undefined
        return h(ContentBlock, {
          // A late response for a previously expanded row must not paint under
          // the row that is open now.
          content: content !== undefined && content.id === id ? content : undefined,
          t,
          markdown,
          onCollapse: () => { collapse(id) },
        })
      }

      const onExpand = async (id) => {
        if (expanded === id) {
          collapse(id)
          return
        }
        const request = contentRequest.current + 1
        contentRequest.current = request
        setExpanded(id)
        setContent({ id, status: 'loading' })
        try {
          const value = await callRemote(() => api.readContent(id))
          if (contentRequest.current !== request) return
          setContent({ id, status: 'ready', value })
        } catch (failure) {
          if (contentRequest.current !== request) return
          setContent({ id, status: 'failed', error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const submitNote = async () => {
        const result = await run('add-note', () => api.addNote(noteTitle, noteText))
        if (result.ok === true) {
          setNoteTitle('')
          setNoteText('')
          setAddKind(undefined)
        }
      }

      const submitFile = async () => {
        const result = await run('add-file', () => api.addFile(filePath))
        if (result.ok === true) {
          setFilePath('')
          setAddKind(undefined)
        }
      }

      if (resource.status === 'loading') return h('p', { className: 'pg-empty' }, t('common.loading'))
      if (resource.status === 'failed') {
        return h('p', { className: 'pg-error', role: 'status' },
          `${t('common.failed')} ${String(resource.failure?.message ?? '')}`)
      }
      if (resource.status === 'none') return h('p', { className: 'pg-empty' }, t('common.failed'))
      if (state === undefined) return h('p', { className: 'pg-empty' }, t('common.loading'))
      if (state.live === false) return h('p', { className: 'pg-empty' }, t('common.unavailable'))

      const plans = Array.isArray(state.plans) ? state.plans : []
      const items = Array.isArray(state.items) ? state.items : []
      const limits = isRecord(state.limits) ? state.limits : {}
      const policy = state.policy ?? state.defaultPolicy ?? 'ask'
      const noteMax = typeof limits.maxCharsPerNote === 'number' ? limits.maxCharsPerNote : 20000
      const itemMax = typeof limits.maxItems === 'number' ? limits.maxItems : 24
      const planRows = plans.slice().reverse().map(plan => h(PlanRow, {
        key: plan.callId,
        plan,
        t,
        busy: busy === `plan:${plan.callId}`,
        expanded: expanded === plan.callId,
        titleRef: attachTitle(plan.callId),
        preview: previewFor(plan.callId),
        onToggle: value => { void run(`plan:${plan.callId}`, () => api.setPlan(plan.callId, value ? 'mounted' : 'unmounted')) },
        onAuto: () => { void run(`plan:${plan.callId}`, () => api.setPlan(plan.callId, 'auto')) },
        onExpand: () => { void onExpand(plan.callId) },
      }))
      const itemRows = items.map(item => h(ItemRow, {
        key: item.id,
        item,
        t,
        busy: busy === `item:${item.id}`,
        expanded: expanded === item.id,
        titleRef: attachTitle(item.id),
        preview: previewFor(item.id),
        deleteConfirm: deleteConfirm === item.id,
        onToggle: value => { void run(`item:${item.id}`, () => api.setMounted(item.id, value)) },
        onLock: value => { void run(`item:${item.id}`, () => api.setLock(item.id, value)) },
        onDelete: () => setDeleteConfirm(item.id),
        onConfirmDelete: () => {
          void run(`item:${item.id}`, () => api.removeItem(item.id)).then(result => {
            if (result.ok !== true) return
            setDeleteConfirm(undefined)
            if (expanded === item.id) {
              contentRequest.current += 1
              setExpanded(undefined)
              setContent(undefined)
            }
          })
        },
        onCancelDelete: () => setDeleteConfirm(undefined),
        onExpand: () => { void onExpand(item.id) },
        onOpenViewer: openInViewer === undefined || item.kind !== 'file'
          || item.path === null || item.path === undefined
          ? undefined
          : () => { openInViewer(item.path) },
      }))

      const addForm = addKind === 'note'
        ? h('div', { className: 'pg-form' },
          h('input', {
            className: 'pg-input', value: noteTitle, maxLength: 200,
            placeholder: t('add.titlePlaceholder'), 'aria-label': t('add.noteTitle'),
            onChange: event => setNoteTitle(event.target.value),
          }),
          h('textarea', {
            className: 'pg-textarea', value: noteText, maxLength: noteMax,
            placeholder: t('add.notePlaceholder'), 'aria-label': t('add.noteText'),
            onChange: event => setNoteText(event.target.value),
          }),
          h('div', { className: 'pg-actions' },
            h('button', {
              type: 'button', className: 'pg-btn pg-btn-primary',
              disabled: busy === 'add-note' || noteText.trim() === '',
              onClick: () => { void submitNote() },
            }, t('add.submit')),
            h('button', {
              type: 'button', className: 'pg-btn', disabled: busy === 'add-note',
              onClick: () => { setAddKind(undefined) },
            }, t('add.cancel')),
          ),
        )
        : addKind === 'file'
          ? h('div', { className: 'pg-form' },
            h('input', {
              className: 'pg-input', value: filePath, maxLength: 4096,
              placeholder: t('add.filePlaceholder'), 'aria-label': t('add.filePath'),
              onChange: event => setFilePath(event.target.value),
            }),
            h('div', { className: 'pg-actions' },
              h('button', {
                type: 'button', className: 'pg-btn pg-btn-primary',
                disabled: busy === 'add-file' || filePath.trim() === '',
                onClick: () => { void submitFile() },
              }, t('add.submit')),
              h('button', {
                type: 'button', className: 'pg-btn', disabled: busy === 'add-file',
                onClick: () => { setAddKind(undefined) },
              }, t('add.cancel')),
            ),
          )
          : h('div', { className: 'pg-actions' },
            h('button', {
              type: 'button', className: 'pg-btn', disabled: busy !== undefined,
              onClick: () => { setAddKind('note'); setError(undefined) },
            }, t('add.note')),
            h('button', {
              type: 'button', className: 'pg-btn', disabled: busy !== undefined,
              onClick: () => { setAddKind('file'); setError(undefined) },
            }, t('add.file')),
          )

      return h('div', { className: 'pg-root' },
        error === undefined ? null : h('p', { className: 'pg-error', role: 'alert' }, `${t('row.error')} ${error}`),
        h('div', { className: 'pg-policy' },
          h('label', { className: 'pg-caption' }, t('policy.label')),
          h(PolicyMenu, {
            policy, busy: busy === 'policy', t,
            onSelect: (value) => { void run('policy', () => api.setPolicy(value)) },
          }),
        ),
        h('section', { className: 'pg-section' },
          h('div', { className: 'pg-sectionHead' },
            h('h3', { className: 'pg-caption' }, t('plans.section')),
            plans.length === 0 ? null : h('span', { className: 'pg-count' }, String(plans.length)),
          ),
          plans.length === 0 ? h('p', { className: 'pg-empty' }, t('plans.empty')) : planRows,
        ),
        h('section', { className: 'pg-section' },
          h('div', { className: 'pg-sectionHead' },
            h('h3', { className: 'pg-caption' }, t('items.section')),
            h('span', { className: 'pg-count' },
              t('items.limit').replace('{count}', String(items.length)).replace('{max}', String(itemMax))),
          ),
          items.length === 0 ? h('p', { className: 'pg-empty' }, t('items.empty')) : itemRows,
          addForm,
        ),
      )
    }

    /** Plain text chip for the tab title seat; the framework owns the chip itself. */
    function DrawerTitle({ t }) { return h('span', {}, t('drawer.title')) }

    /** The namespace service this plugin mounts for itself. */
    const REMOTE_DEPENDENCY = `remote.${REMOTE_NS}`

    /**
     * Register dictionaries, the drawer resource and tab kind, and both slot
     * seats. Runs inside an `ctx.inject` group because a namespace this plugin
     * mounts itself cannot also sit in the static `inject` list: activation
     * would wait on a service its own `apply` has not created yet, and reading
     * `ctx.remote[namespace]` outside an inject group throws.
     */
    function registerUi(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      const remote = ctx.remote[REMOTE_NS]

      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), 'dsh-plan-guard: dictionaries')
      ctx.effect(() => ensureStyles(), 'dsh-plan-guard: drawer styles')
      ctx.effect(
        () => ctx.resources.register({
          protocol: TAB_KIND,
          open(address, openCtx) { return openDrawerResource(remote, address, openCtx) },
        }),
        'dsh-plan-guard: drawer resource',
      )
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: PLUGIN_ID,
          kind: TAB_KIND,
          title: () => t('drawer.tabTitle'),
          guide: [{
            id: 'guarded-context',
            order: 20,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: GuardedIcon,
          }],
        }),
        'dsh-plan-guard: sidebar tab type',
      )
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: PLUGIN_ID, locale: LOCALE_NS,
        inject: sessionId => ({
          api: {
            list: () => remote.list(sessionId),
            setPolicy: policy => remote.setPolicy(sessionId, policy),
            setPlan: (callId, choice) => remote.setPlan(sessionId, callId, choice),
            addNote: (title, text) => remote.addNote(sessionId, title, text),
            addFile: path => remote.addFile(sessionId, path),
            setMounted: (itemId, mounted) => remote.setMounted(sessionId, itemId, mounted),
            setLock: (itemId, locked) => remote.setLock(sessionId, itemId, locked),
            removeItem: itemId => remote.removeItem(sessionId, itemId),
            readContent: id => remote.content(sessionId, id),
          },
        }),
      }, Drawer))
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID, locale: LOCALE_NS,
      }, DrawerTitle))
    }

    return {
      inject: ['slots', 'locale', 'resources', 'remote', 'sidebarRight', 'sidebarRightTabs'],
      __testables: { drawerAddress, sessionIdOfAddress, Drawer, ContentBlock, PlanRow, ItemRow },
      /** Mount the Remote namespace, then join the UI once that namespace is readable. */
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(remoteContribution)
        const ui = ctx.inject([REMOTE_DEPENDENCY, 'slots', 'locale', 'resources', 'sidebarRightTabs'], registerUi)
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await disposeRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await disposeRemote()
        }
      },
    }
  },
})
