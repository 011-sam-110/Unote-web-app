// The one line buildExtensions needs. Keeping the registration here rather than inlining a
// plugin construction in the shared extension list keeps that file's diff to a single import
// and a single array entry - which matters while another agent is editing the same file.
import { Extension } from '@tiptap/core';
import { createSpellPlugin } from './SpellPlugin';
import { lintText, preloadLinter } from './linter';
import { primeDictionary } from './dictionary';
import './spell.css';

export const SpellCheck = Extension.create({
  name: 'folioSpellCheck',

  onCreate() {
    // Start fetching the engine as soon as an editor exists, so the download overlaps with
    // the user reading their note rather than with their first keystroke. The linter itself
    // is a module singleton, so the second, third and fourth mounted editor are free.
    const view = this.editor.view;
    // Queued before the engine exists; replayed on load. A word the user taught it last
    // session must be known on the FIRST lint, or they watch their own name get squiggled
    // again and reasonably conclude the setting did not stick.
    void primeDictionary();
    preloadLinter().catch(() => {
      // The engine could not load - offline before it was ever cached, or the asset is gone.
      // WITHOUT this the failure is invisible and reads as success: no engine means no
      // issues, and a note with no squiggles looks like a note with no mistakes. Handing
      // spelling back to the browser degrades to a worse checker rather than to a silent
      // one, which is the only honest failure mode available here.
      view.dom.setAttribute('spellcheck', 'true');
    });
  },

  addProseMirrorPlugins() {
    return [createSpellPlugin(lintText)];
  },
});

export default SpellCheck;
