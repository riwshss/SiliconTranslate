import type { ErrorCode, WireError } from '../shared/messages'

const FRIENDLY: Record<ErrorCode, string> = {
  'no-key': '还没有填写 API Key，请点击扩展图标完成设置',
  unavailable: '浏览器内置模型不可用',
  'model-download': '本地模型尚未下载，请点击扩展图标 →「检查 / 下载模型」',
  auth: 'API Key 无效或已过期',
  'rate-limit': '请求太频繁（429），请稍后再试或调低并发数',
  'bad-request': '请求被拒绝，请检查模型名称或接口设置',
  network: '网络连接失败，请检查网络或代理',
  server: '翻译服务暂时不可用',
  'bad-response': '模型返回内容无法解析',
  aborted: '已取消',
  extension: '扩展已更新，请刷新页面',
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${FRIENDLY[code]}：${detail}` : FRIENDLY[code])
    this.name = 'ApiError'
  }

  toWire(): WireError {
    return { code: this.code, message: this.message }
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof DOMException && err.name === 'AbortError') return new ApiError('aborted')
  return new ApiError('network', err instanceof Error ? err.message : String(err))
}
