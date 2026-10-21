import { Extension } from '@tiptap/core'

/**
 * Agent 写进文档的草稿段落：
 *  - draft：草稿所属的任务和章节（如 "3f9a2c1b-2"），用户「保留」后清除；带这个属性的段落显示为紫色草稿样式
 *  - live：正在流式写入（末尾显示闪烁的光标），写完清除
 * 属性随文档一起保存，刷新页面后草稿仍在，可以继续保留或删除。
 */
export const DraftParagraph = Extension.create({
  name: 'draftParagraph',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          draft: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-draft'),
            renderHTML: (a) => (a.draft ? { 'data-draft': a.draft, class: 'ai-draft' } : {}),
          },
          live: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-live'),
            renderHTML: (a) => (a.live ? { 'data-live': a.live } : {}),
          },
        },
      },
    ]
  },
})
