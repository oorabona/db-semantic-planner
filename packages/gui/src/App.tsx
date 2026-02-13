import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
	ConnectionDialog,
	type ConnectionFormData,
} from '@/components/connection/ConnectionDialog';
import { ConnectionStatus } from '@/components/connection/ConnectionStatus';
import { EditorPanel } from '@/components/layout/EditorPanel';
import { ResultsPanel } from '@/components/layout/ResultsPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { Button } from '@/components/ui/button';
import { useConnection } from '@/hooks/useConnection';
import { useMonacoSetup } from '@/hooks/useMonacoSetup';
import { useConnectionStore } from '@/stores/connection-store';

export default function App() {
	useMonacoSetup();
	const [dialogOpen, setDialogOpen] = useState(false);
	const { status, active, error } = useConnectionStore();
	const { connect, testConnection, testResult, disconnect } = useConnection();
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);

	const handleConnect = async (data: ConnectionFormData) => {
		setConnecting(true);
		try {
			await connect(data);
			setDialogOpen(false);
		} catch {
			// error handled by store
		} finally {
			setConnecting(false);
		}
	};

	const handleTest = async (data: ConnectionFormData) => {
		setTesting(true);
		try {
			await testConnection(data);
		} finally {
			setTesting(false);
		}
	};

	const handleSave = (data: ConnectionFormData) => {
		const { addProfile } = useConnectionStore.getState();
		addProfile({
			id: crypto.randomUUID(),
			name: data.name || `${data.database}@${data.host}`,
			host: data.host,
			port: data.port,
			database: data.database,
			user: data.user,
			schema: data.schema,
			sslMode: data.sslMode,
		});
	};

	return (
		<div className="flex h-screen w-screen flex-col">
			{/* Main layout */}
			<div className="flex-1 overflow-hidden">
				<PanelGroup autoSaveId="dbsp-main-layout" direction="horizontal">
					{/* Left: Schema sidebar */}
					<Panel defaultSize={20} minSize={15} maxSize={40}>
						<Sidebar />
					</Panel>

					<PanelResizeHandle />

					{/* Right: Editor + Results (vertical split) */}
					<Panel defaultSize={80} minSize={40}>
						<PanelGroup autoSaveId="dbsp-right-layout" direction="vertical">
							{/* Top-right: Editor */}
							<Panel defaultSize={55} minSize={20}>
								<EditorPanel />
							</Panel>

							<PanelResizeHandle />

							{/* Bottom-right: Results */}
							<Panel defaultSize={45} minSize={15}>
								<ResultsPanel />
							</Panel>
						</PanelGroup>
					</Panel>
				</PanelGroup>
			</div>

			{/* Status bar */}
			<div className="flex h-6 items-center justify-between border-t bg-background px-2">
				<ConnectionStatus
					status={status}
					database={active?.database}
					schema={active?.schema}
					error={error}
					onReconnect={() => setDialogOpen(true)}
				/>
				<Button
					variant="ghost"
					size="icon"
					className="h-5 w-5"
					onClick={() =>
						status === 'connected' ? disconnect() : setDialogOpen(true)
					}
					title={status === 'connected' ? 'Disconnect' : 'New connection'}
				>
					<Plus className="h-3.5 w-3.5" />
				</Button>
			</div>

			{/* Connection dialog */}
			<ConnectionDialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				onConnect={handleConnect}
				onTest={handleTest}
				onSave={handleSave}
				testing={testing}
				connecting={connecting}
				testResult={testResult}
			/>
		</div>
	);
}
