import {
	Panel,
	PanelGroup,
	PanelResizeHandle,
} from "react-resizable-panels";
import { Sidebar } from "@/components/layout/Sidebar";
import { EditorPanel } from "@/components/layout/EditorPanel";
import { ResultsPanel } from "@/components/layout/ResultsPanel";

export default function App() {
	return (
		<div className="h-screen w-screen">
			<PanelGroup
				autoSaveId="dbsp-main-layout"
				direction="horizontal"
			>
				{/* Left: Schema sidebar */}
				<Panel defaultSize={20} minSize={15} maxSize={40}>
					<Sidebar />
				</Panel>

				<PanelResizeHandle />

				{/* Right: Editor + Results (vertical split) */}
				<Panel defaultSize={80} minSize={40}>
					<PanelGroup
						autoSaveId="dbsp-right-layout"
						direction="vertical"
					>
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
	);
}
