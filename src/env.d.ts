/**
 * 浏览器全局声明：DSH 客户端模块加载器与 CDN 版 Monaco。
 * 只声明本插件实际用到的最小面。
 */

declare global {

/** Monaco 文本模型最小面。 */
interface MonacoTextModel {
  dispose(): void
  getValue(): string
}

/** Monaco 编辑器实例最小面。 */
interface MonacoEditorInstance {
  dispose(): void
  getValue(): string
  setModel(model: MonacoTextModel | null): void
  setTheme(theme: string): void
  addCommand(keybinding: number, handler: () => void): void
  onDidChangeModelContent(handler: () => void): void
}

/** Monaco 全局命名空间最小面。 */
interface MonacoNamespace {
  editor: {
    create(container: HTMLElement, options: Record<string, unknown>): MonacoEditorInstance
    createModel(value: string, language?: string): MonacoTextModel
  }
  KeyMod: { CtrlCmd: number }
  KeyCode: { KeyS: number }
}

/** AMD 加载器：Monaco 的 loader.js 提供。 */
interface MonacoAmdRequire {
  (modules: string[], onLoad: () => void): void
  config(options: { paths: Record<string, string> }): void
}

interface Window {
  /** DSH 客户端模块表：客户端插件经它注册。 */
  __ModuleLoader__: {
    load(entry: {
      id: string
      factory: (require: (id: string) => unknown) => unknown
    }): void
  }
  /** Monaco 加载完成后由 loader.js 挂到全局。 */
  monaco: MonacoNamespace
  /** Monaco 的 AMD require。 */
  require: MonacoAmdRequire
}
}

export {}
