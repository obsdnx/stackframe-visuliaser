import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { cpp } from '@codemirror/lang-cpp'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration } from '@codemirror/view'

const setSourceLine = StateEffect.define()

const sourceLineField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setSourceLine)) {
        if (e.value == null) {
          deco = Decoration.none
        } else {
          const line = tr.state.doc.line(e.value)
          deco = Decoration.set([
            Decoration.line({ class: 'cm-source-active' }).range(line.from),
          ])
        }
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

export default function CodeEditor({ value, onChange, highlightLine }) {
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  const suppressRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          cpp(),
          oneDark,
          sourceLineField,
          EditorView.updateListener.of(update => {
            if (update.docChanged && !suppressRef.current) {
              onChange(update.state.doc.toString())
            }
          }),
          EditorView.theme({
            '&': { height: '100%', background: '#1e1e2e' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { padding: '8px 0' },
            '.cm-source-active': {
              background: 'rgba(166, 227, 161, 0.15)',
              borderLeft: '3px solid #a6e3a1',
            },
          }),
        ],
      }),
      parent: containerRef.current,
    })

    viewRef.current = view
    return () => view.destroy()
  }, [])

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      suppressRef.current = true
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
      suppressRef.current = false
    }
  }, [value])

  // Highlight active source line
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const lineCount = view.state.doc.lines
    const lineNum = highlightLine != null && highlightLine >= 1 && highlightLine <= lineCount
      ? highlightLine
      : null
    view.dispatch({ effects: setSourceLine.of(lineNum) })
    if (lineNum != null) {
      const line = view.state.doc.line(lineNum)
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    }
  }, [highlightLine])

  return <div ref={containerRef} style={{ height: '100%' }} />
}
