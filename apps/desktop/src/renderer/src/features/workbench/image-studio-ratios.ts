/** Aspect ratio menu exposed by fximg.dgjapp.com across its AI image tools. */
export interface ImageStudioRatioOption {
  key: string
  label: string
  /** Nearest output size accepted by the app's configured image endpoint. */
  requestSize: '1024x1024' | '1536x1024' | '1024x1536'
}

export const IMAGE_STUDIO_RATIO_OPTIONS: ImageStudioRatioOption[] = [
  { key: '1:1', label: '1:1 正方形', requestSize: '1024x1024' },
  { key: '1:2', label: '1:2 竖版', requestSize: '1024x1536' },
  { key: '1:3', label: '1:3 竖版', requestSize: '1024x1536' },
  { key: '2:1', label: '2:1 横版', requestSize: '1536x1024' },
  { key: '2:3', label: '2:3 竖版', requestSize: '1024x1536' },
  { key: '3:2', label: '3:2 横版', requestSize: '1536x1024' },
  { key: '3:4', label: '3:4 竖版', requestSize: '1024x1536' },
  { key: '4:3', label: '4:3 横版', requestSize: '1536x1024' },
  { key: '9:16', label: '9:16 手机竖屏', requestSize: '1024x1536' },
  { key: '9:21', label: '9:21 超高竖屏', requestSize: '1024x1536' }
]

export const IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS: ImageStudioRatioOption[] = [
  ...IMAGE_STUDIO_RATIO_OPTIONS,
  { key: '16:9', label: '16:9 宽屏', requestSize: '1536x1024' },
  { key: '21:9', label: '21:9 超宽屏', requestSize: '1536x1024' }
]

export function imageStudioRequestSize(ratio: string): ImageStudioRatioOption['requestSize'] {
  return IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS.find(option => option.key === ratio)?.requestSize || '1024x1024'
}
