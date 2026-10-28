declare module '@deepseek-ai/cordis' {
  export interface Context {
    on(...args: any[]): any
    logger?: {
      info?: (...args: any[]) => void
      warn?: (...args: any[]) => void
      error?: (...args: any[]) => void
    }
  }
}
