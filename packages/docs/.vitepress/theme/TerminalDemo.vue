<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

type Step = {
	prompt: string;
	promptClass: string;
	command: string;
	output: string[];
	typingSpeed?: number;
};

const steps: Step[] = [
	{
		prompt: '$ ',
		promptClass: 'prompt-shell',
		command: 'pnpm add @dbsp/core @dbsp/adapter-pgsql',
		output: ['Added 2 packages.'],
		typingSpeed: 40,
	},
	{
		prompt: '$ ',
		promptClass: 'prompt-shell',
		command: 'dbsp repl --schema ./blog.schema.ts',
		output: ['Connected — compile-only mode (no database needed).', 'dbsp> '],
		typingSpeed: 40,
	},
	{
		prompt: 'dbsp> ',
		promptClass: 'prompt-repl',
		command: 'users | where active = true | select id, name',
		output: [
			'SELECT "users"."id", "users"."name"',
			'FROM "users"',
			'WHERE "users"."active" = $1',
			'',
			'Parameters: [true]',
		],
		typingSpeed: 30,
	},
	{
		prompt: 'dbsp> ',
		promptClass: 'prompt-repl',
		command: 'posts | where published = true | include author',
		output: [
			'SELECT "posts".*, row_to_json("author_sq".*) AS "author"',
			'FROM "posts"',
			'LEFT JOIN LATERAL (',
			'  SELECT "users".* FROM "users"',
			'  WHERE "users"."id" = "posts"."author_id"',
			') AS "author_sq" ON true',
			'WHERE "posts"."published" = $1',
			'',
			'Parameters: [true]',
			'Plan: include-strategy -> lateral-join (to-one relation)',
		],
		typingSpeed: 25,
	},
	{
		prompt: 'dbsp> ',
		promptClass: 'prompt-repl',
		command: '.tables',
		output: ['users    posts    comments'],
		typingSpeed: 35,
	},
];

type Line = {
	prompt: string;
	promptClass: string;
	command: string;
	done: boolean;
	output: string[];
};

const lines = ref<Line[]>([]);
const currentChar = ref(0);
const isIdle = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;
let stepIndex = 0;

function clearTimer() {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
}

function scheduleNext(fn: () => void, delay: number) {
	clearTimer();
	timer = setTimeout(fn, delay);
}

function startStep(index: number) {
	if (index >= steps.length) {
		isIdle.value = true;
		scheduleNext(() => {
			isIdle.value = false;
			lines.value = [];
			currentChar.value = 0;
			stepIndex = 0;
			startStep(0);
		}, 3000);
		return;
	}

	const step = steps[index];
	const speed = step.typingSpeed ?? 40;

	lines.value.push({
		prompt: step.prompt,
		promptClass: step.promptClass,
		command: '',
		done: false,
		output: [],
	});

	currentChar.value = 0;
	isIdle.value = false;

	function typeNextChar() {
		const line = lines.value[lines.value.length - 1];
		if (currentChar.value < step.command.length) {
			line.command = step.command.slice(0, currentChar.value + 1);
			currentChar.value++;
			// Auto-scroll terminal body
			nextTick(() => {
				const el = document.querySelector('.terminal-body');
				if (el) el.scrollTop = el.scrollHeight;
			});
			scheduleNext(typeNextChar, speed);
		} else {
			line.done = true;
			scheduleNext(() => {
				line.output = step.output;
				stepIndex = index + 1;
				// Auto-scroll terminal body
				nextTick(() => {
					const el = document.querySelector('.terminal-body');
					if (el) el.scrollTop = el.scrollHeight;
				});
				scheduleNext(() => startStep(stepIndex), 1500);
			}, 200);
		}
	}

	scheduleNext(typeNextChar, speed);
}

onMounted(() => {
	scheduleNext(() => startStep(0), 800);
});

onUnmounted(() => {
	clearTimer();
});

function isSqlLine(text: string): boolean {
	return /^\s*(SELECT|FROM|WHERE|LEFT|RIGHT|INNER|JOIN|GROUP|ORDER|HAVING|LIMIT|OFFSET|WITH|INSERT|UPDATE|DELETE|ON|AS|LATERAL)\b/.test(
		text,
	);
}

function isPlanLine(text: string): boolean {
	return text.startsWith('Plan:');
}

function isParamLine(text: string): boolean {
	return text.startsWith('Parameters:');
}

/**
 * When a line has output rows, the cursor should follow the last output row,
 * not stay on the input row. This computed tracks which row the cursor sits on.
 */
const cursorLine = computed(() => {
	if (isIdle.value || lines.value.length === 0) return null;
	const lastLineIdx = lines.value.length - 1;
	const lastLine = lines.value[lastLineIdx];
	if (lastLine.output.length > 0) {
		// cursor belongs on the last output row of the last line
		return {
			kind: 'output' as const,
			lineIdx: lastLineIdx,
			outIdx: lastLine.output.length - 1,
		};
	}
	// still typing — cursor on the input row
	return { kind: 'input' as const, lineIdx: lastLineIdx };
});
</script>

<template>
  <div class="terminal">
    <div class="terminal-header">
      <span class="terminal-dot dot-red" />
      <span class="terminal-dot dot-yellow" />
      <span class="terminal-dot dot-green" />
      <span class="terminal-title">dbsp</span>
    </div>
    <div class="terminal-body">
      <div v-for="(line, i) in lines" :key="i" class="terminal-line-group">
        <div class="terminal-row">
          <span :class="['prompt', line.promptClass]">{{ line.prompt }}</span>
          <span class="command-text">{{ line.command }}</span>
          <span
            v-if="cursorLine?.kind === 'input' && cursorLine.lineIdx === i"
            class="cursor"
          />
        </div>
        <div
          v-for="(out, j) in line.output"
          :key="j"
          class="terminal-row output-row"
        >
          <span v-if="isSqlLine(out)" class="output-sql">{{ out }}</span>
          <span v-else-if="isPlanLine(out)" class="output-highlight">{{ out }}</span>
          <span v-else-if="isParamLine(out)" class="output-text">{{ out }}</span>
          <span v-else class="output-text">{{ out }}</span>
          <span
            v-if="cursorLine?.kind === 'output' && cursorLine.lineIdx === i && cursorLine.outIdx === j"
            class="cursor"
          />
        </div>
      </div>
      <div v-if="isIdle" class="terminal-row">
        <span class="prompt prompt-repl">dbsp&gt; </span>
        <span class="cursor" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Terminal stays dark intentionally — macOS terminal aesthetic. Site theme is independent. */
.terminal {
  background: #0f172a;
  border-radius: var(--dbsp-radius-md, 8px);
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  /* Centralise mono font — falls back to JetBrains Mono if VP var not set */
  font-family: var(--vp-font-family-mono, 'JetBrains Mono', monospace);
  font-size: 0.82rem;
  line-height: 1.65;
  max-width: 720px;
  margin: var(--dbsp-space-2xl, 2rem) auto;
  /* Tell the browser this panel is always dark — dark scrollbars, color-scheme-aware UA styles */
  color-scheme: dark;
}

.terminal-header {
  background: #1e293b;
  padding: 0.5rem 0.75rem;
  display: flex;
  align-items: center;
  gap: 6px;
}

.terminal-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

/* Terminal is locked dark via color-scheme: dark.
   Pin status accents to bright values so dots stay punchy
   regardless of the surrounding site theme. */
.terminal {
  --dbsp-c-error: #f87171;
  --dbsp-c-warning: #fbbf24;
  --dbsp-c-success: #4ade80;
}

/* Terminal is always dark — dot colors use the pinned bright values above */
.dot-red { background: var(--dbsp-c-error, #ef4444); }
.dot-yellow { background: var(--dbsp-c-warning, #eab308); }
.dot-green { background: var(--dbsp-c-success, #22c55e); }

.terminal-title {
  flex: 1;
  text-align: center;
  color: #94a3b8;
  font-size: 0.75rem;
}

.terminal-body {
  padding: 1rem;
  height: 280px;
  overflow-y: auto;
  color: #E2E8F0;
}

.terminal-line-group {
  margin-bottom: 0.25rem;
}

.terminal-row {
  display: flex;
  align-items: baseline;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-row {
  padding-left: 0;
}

.prompt {
  flex-shrink: 0;
  user-select: none;
}

.prompt-shell { color: #22c55e; }
.prompt-repl { color: #22d3ee; }

.command-text { color: #e2e8f0; }

.output-text { color: #94a3b8; }

.output-sql { color: #818cf8; }

.output-highlight { color: #22d3ee; }

.cursor {
  display: inline-block;
  width: 8px;
  height: 1.1em;
  background: #e2e8f0;
  vertical-align: text-bottom;
  flex-shrink: 0;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}
</style>
