<script setup lang="ts">
/**
 * Vue TermUI POC - REPL interface
 *
 * DX-030-SPIKE: Evaluating vue-termui for CLI REPL framework
 * Features: input handling, box layouts, table rendering, styling
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { TuiBox, TuiText, useApp, useStdin } from 'vue-termui';

// Types
interface HistoryEntry {
	command: string;
	timestamp: Date;
}

interface TableRow {
	id: number;
	name: string;
	email: string;
	active: boolean;
}

// State
const input = ref('');
const history = ref<HistoryEntry[]>([]);
const showHelp = ref(false);
const output = ref<{
	type: 'sql' | 'plan' | 'table' | 'message' | null;
	content: any;
}>({ type: null, content: null });

// Mock data for table demonstration
const mockTableData: TableRow[] = [
	{ id: 1, name: 'Alice', email: 'alice@example.com', active: true },
	{ id: 2, name: 'Bob', email: 'bob@example.com', active: false },
	{ id: 3, name: 'Charlie', email: 'charlie@example.com', active: true },
];

// App instance for exit
const { exit } = useApp();

// Input handling
const { stdin, setRawMode } = useStdin();

// Handle keyboard input
const handleKeypress = (data: Buffer) => {
	const char = data.toString();
	const code = data[0];

	// Ctrl+C - exit
	if (code === 3) {
		exit();
		return;
	}

	// Enter - submit
	if (code === 13) {
		handleSubmit();
		return;
	}

	// Backspace
	if (code === 127) {
		input.value = input.value.slice(0, -1);
		return;
	}

	// Printable characters
	if (code >= 32 && code <= 126) {
		input.value += char;
	}
};

// Command submission
const handleSubmit = () => {
	const cmd = input.value.trim();
	if (!cmd) return;

	// Add to history
	history.value.push({ command: cmd, timestamp: new Date() });

	// Process commands
	if (cmd === '.help') {
		showHelp.value = true;
		output.value = { type: null, content: null };
	} else if (cmd === '.clear') {
		showHelp.value = false;
		output.value = { type: null, content: null };
		history.value = [];
	} else if (cmd === '.tables') {
		output.value = {
			type: 'message',
			content: 'Tables: users, posts, comments, categories',
		};
		showHelp.value = false;
	} else if (cmd.toLowerCase().startsWith('select')) {
		// Simulate query execution
		output.value = {
			type: 'table',
			content: {
				sql: `SELECT id, name, email, active FROM users WHERE active = $1`,
				params: [true],
				plan: {
					root: 'users',
					strategy: 'index_scan',
					cost: 12.5,
				},
				data: mockTableData,
			},
		};
		showHelp.value = false;
	} else {
		output.value = {
			type: 'message',
			content: `Unknown command: ${cmd}. Type .help for available commands.`,
		};
		showHelp.value = false;
	}

	input.value = '';
};

// Lifecycle
onMounted(() => {
	if (setRawMode) {
		setRawMode(true);
	}
	if (stdin) {
		stdin.on('data', handleKeypress);
	}
});

onUnmounted(() => {
	if (stdin) {
		stdin.off('data', handleKeypress);
	}
});

// Computed for table rendering
const tableColumns = ['id', 'name', 'email', 'active'];
</script>

<template>
  <TuiBox :flexDirection="'column'" :padding="1">
    <!-- Header -->
    <TuiBox :borderStyle="'round'" :borderColor="'cyan'" :paddingX="2">
      <TuiText :color="'cyan'" :bold="true">
        db-semantic-planner REPL (vue-termui POC)
      </TuiText>
    </TuiBox>

    <!-- Help Display -->
    <TuiBox
      v-if="showHelp"
      :flexDirection="'column'"
      :borderStyle="'single'"
      :borderColor="'yellow'"
      :marginTop="1"
      :paddingX="1"
    >
      <TuiText :color="'yellow'" :bold="true">Available Commands:</TuiText>
      <TuiText>  .help    - Show this help</TuiText>
      <TuiText>  .tables  - List available tables</TuiText>
      <TuiText>  .clear   - Clear screen and history</TuiText>
      <TuiText>  Ctrl+C   - Exit REPL</TuiText>
      <TuiText />
      <TuiText :dimmed="true">Enter SQL queries to execute them</TuiText>
    </TuiBox>

    <!-- SQL Output -->
    <TuiBox
      v-if="output.type === 'table'"
      :flexDirection="'column'"
      :marginTop="1"
    >
      <!-- SQL Display -->
      <TuiBox :borderStyle="'single'" :borderColor="'blue'" :paddingX="1">
        <TuiText :color="'blue'" :bold="true">SQL: </TuiText>
        <TuiText :color="'white'">{{ output.content.sql }}</TuiText>
      </TuiBox>

      <!-- Plan Display -->
      <TuiBox
        :borderStyle="'single'"
        :borderColor="'magenta'"
        :paddingX="1"
        :marginTop="1"
      >
        <TuiText :color="'magenta'" :bold="true">Plan: </TuiText>
        <TuiText :color="'white'">
          {{ output.content.plan.strategy }} on {{ output.content.plan.root }}
          (cost: {{ output.content.plan.cost }})
        </TuiText>
      </TuiBox>

      <!-- Results Table -->
      <TuiBox
        :flexDirection="'column'"
        :borderStyle="'single'"
        :borderColor="'green'"
        :marginTop="1"
      >
        <!-- Table Header -->
        <TuiBox :paddingX="1">
          <TuiText
            v-for="col in tableColumns"
            :key="col"
            :color="'green'"
            :bold="true"
            :width="15"
          >
            {{ col.toUpperCase() }}
          </TuiText>
        </TuiBox>
        <!-- Table Rows -->
        <TuiBox
          v-for="(row, idx) in output.content.data"
          :key="idx"
          :paddingX="1"
        >
          <TuiText :width="15">{{ row.id }}</TuiText>
          <TuiText :width="15">{{ row.name }}</TuiText>
          <TuiText :width="15">{{ row.email }}</TuiText>
          <TuiText :width="15" :color="row.active ? 'green' : 'red'">
            {{ row.active ? 'Yes' : 'No' }}
          </TuiText>
        </TuiBox>
      </TuiBox>

      <!-- Row Count -->
      <TuiText :color="'gray'" :marginTop="1">
        {{ output.content.data.length }} row(s) returned
      </TuiText>
    </TuiBox>

    <!-- Message Output -->
    <TuiBox v-if="output.type === 'message'" :marginTop="1">
      <TuiText :color="'yellow'">{{ output.content }}</TuiText>
    </TuiBox>

    <!-- History -->
    <TuiBox
      v-if="history.length > 0"
      :flexDirection="'column'"
      :marginTop="1"
      :borderStyle="'single'"
      :borderColor="'gray'"
      :paddingX="1"
    >
      <TuiText :color="'gray'" :dimmed="true">History:</TuiText>
      <TuiText
        v-for="(entry, idx) in history.slice(-5)"
        :key="idx"
        :color="'gray'"
      >
        {{ idx + 1 }}. {{ entry.command }}
      </TuiText>
    </TuiBox>

    <!-- Input Prompt -->
    <TuiBox :marginTop="1">
      <TuiText :color="'green'" :bold="true">&gt; </TuiText>
      <TuiText>{{ input }}</TuiText>
      <TuiText :color="'green'">█</TuiText>
    </TuiBox>
  </TuiBox>
</template>
