<template>
  <div class="thought-header">
    <span
      v-if="live"
      class="thought-dot"
      aria-hidden="true"
    />
    <span
      class="thought-label"
      :class="{ flowing: live }"
    >{{ label }}</span>
    <span
      v-if="meta"
      class="thought-detail thought-meta"
    >
      <span
        class="thought-detail-separator"
        aria-hidden="true"
      >·</span>
      <span class="thought-detail-text">{{ meta }}</span>
    </span>
    <span
      v-if="detail"
      class="thought-detail"
    >
      <span
        class="thought-detail-separator"
        aria-hidden="true"
      >·</span>
      <span
        class="thought-detail-text"
        :class="{ tail: detailTail }"
      ><bdi>{{ detail }}</bdi></span>
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * The one "Thought" line in the whole app.
 *
 * There are two mount points and they used to be two different-looking
 * components: MessageThinking (top-of-message `message.reasoning`) drew a mono
 * 11px row reading "Thought for 3.2s", while MessageBubble's inline reasoning
 * part drew a sans row reading "Thought · <summary>". Same idea, two skins —
 * so the same message could show both and read as two unrelated features.
 *
 * This component is the single skin. The copy rule is uniform too: a label
 * plus an optional detail behind a middot (a summary for inline thoughts, the
 * elapsed time for the top one). The data flow is untouched — top reasoning
 * still travels on `message.reasoning`, inline reasoning still on contentParts.
 */
withDefaults(defineProps<{
  /** 'Thought' when settled; 'Thinking' / 'Waiting' while live. */
  label: string
  /** Short fixed-width fact (elapsed time) that never gets ellipsised; sits before `detail`. */
  meta?: string
  /** Summary or elapsed time. Rendered behind a middot, ellipsised. */
  detail?: string
  /**
   * Show the END of `detail` when it does not fit (ellipsis on the left) —
   * for the live reasoning tail streaming through a collapsed thought header,
   * where the newest words are the ones that matter.
   */
  detailTail?: boolean
  /** Live phase: pulsing dot + breathing label. */
  live?: boolean
}>(), {
  meta: '',
  detail: '',
  detailTail: false,
  live: false,
})
</script>

<style scoped>
.thought-header {
  --thought-fg: var(--ui-message-thinking-fg);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 22px;
  padding: 1px 0;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--thought-fg) 88%, transparent);
  cursor: pointer;
  font: inherit;
  line-height: var(--type-meta-line-height);
}

.thought-header:hover {
  color: var(--thought-fg);
}

.thought-label {
  flex: 0 0 auto;
  font-size: var(--type-meta-size);
  font-weight: var(--type-meta-weight);
}

.thought-label.flowing {
  animation: thought-label-pulse 1.6s ease-in-out infinite;
}

.thought-detail {
  min-width: 0;
  max-width: min(72ch, 100%);
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  overflow: hidden;
  color: color-mix(in srgb, var(--thought-fg) 78%, transparent);
  font-size: var(--type-meta-size);
  font-weight: var(--type-meta-weight);
  line-height: var(--type-meta-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thought-meta {
  flex: 0 0 auto;
  overflow: visible;
}

.thought-detail-separator {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--thought-fg) 52%, transparent);
}

.thought-detail-text {
  min-width: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Left-side ellipsis: lay the box out RTL so overflow clips (and the ellipsis
   lands) at the start; the <bdi> keeps the text itself LTR. */
.thought-detail-text.tail {
  direction: rtl;
  text-align: left;
  font-variant-numeric: normal;
}

.thought-detail-text.tail > bdi {
  direction: ltr;
  unicode-bidi: isolate;
}

/* Liveness cue for the phases that have no other one (waiting / thinking
   before any text has landed). A settled header has no dot, which is why the
   two mount points are pixel-identical in the state users see most. */
.thought-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-accent-primary-fg);
  animation: thought-dot-pulse 1.35s ease-in-out infinite;
}

@keyframes thought-dot-pulse {
  0%, 100% {
    opacity: 0.58;
    transform: scale(0.86);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes thought-label-pulse {
  0%, 100% {
    opacity: 0.76;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thought-dot,
  .thought-label.flowing {
    animation: none;
  }
}
</style>

<style>
/* Published UNSCOPED on purpose: this is the body half of the same
   presentation, and it has to paint elements that live in the consumers'
   templates (inside CollapsePanel's default slot), not in this one. Same
   precedent as Dialog.vue's `.app-dialog-text-btn`.
   The blueprint outline is the shared look; ProcessRail only positions it
   (margin), it no longer repaints it. */
.thought-body {
  min-height: 0;
  overflow: hidden;
  padding: 8px 10px;
  /* No frame (2026-08-17 拍板): the thought body is quiet text under its
     header, not a boxed panel. */
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ui-message-thinking-fg);
  font-family: var(--font-sans, inherit);
  font-size: var(--type-meta-size);
  line-height: 1.65;
}

.thought-body p {
  margin: 0 0 0.5em;
}

.thought-body p:last-child {
  margin-bottom: 0;
}

/* Streaming segment shells: only the last segment's last <p> is the body's
   last <p> (see markdown.css). */
.thought-body .md-segment:not(:last-of-type) > p:last-child {
  margin-bottom: 0.5em;
}

.thought-body ul {
  padding-left: 1.5em;
}

/* 小字号下 1.5em 装不下两位数 marker,溢出会被自身 overflow: hidden 裁掉 */
.thought-body ol {
  padding-left: 2.4em;
}
</style>
