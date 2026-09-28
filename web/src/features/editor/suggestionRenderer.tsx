// Generic @tiptap/suggestion `render()` factory: mounts a React list component via
// ReactRenderer and lets the Suggestion plugin manage positioning (props.mount).
// Shared by SlashCommand and WikilinkExtension so both popups behave identically.
import { ReactRenderer } from '@tiptap/react';
import type { ComponentType } from 'react';

export interface SuggestionListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export function createSuggestionRenderer(Component: ComponentType<any>) {
  return () => {
    let component: ReactRenderer<SuggestionListHandle, any> | null = null;
    let unmount: (() => void) | null = null;

    return {
      onStart: (props: any) => {
        component = new ReactRenderer(Component, { props, editor: props.editor });
        // mount() positions this wrapper absolutely on <body>; without a layer of its own it
        // paints under the paged editor's text (z-index 1), which then takes every click
        // and wheel event aimed at the popup.
        component.element.classList.add('folio-suggestion-layer');
        if (!props.clientRect) return;
        unmount = props.mount(component.element);
      },
      onUpdate: (props: any) => {
        component?.updateProps(props);
      },
      onKeyDown: (props: any) => {
        if (props.event.key === 'Escape') {
          unmount?.();
          component?.destroy();
          return true;
        }
        return component?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        unmount?.();
        component?.destroy();
        component = null;
        unmount = null;
      },
    };
  };
}
