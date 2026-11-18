// Router side of the notes inbox (plan 2.12). The format lives in the notes addon (src/addons/notes/format.ts); the core
// keeps a copy of it for the fallback, when the addon is not installed or not enabled. parseNote is re-exported for the
// legacy reader used in test/notes.test.ts.
export { parseNote } from '../brain/prefixes.ts'
export { attachmentFileName, fileStamp, formatNoteEntry, localStamp, type NoteAttachment } from '../addons/notes/format.ts'
