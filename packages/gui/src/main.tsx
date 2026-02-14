import React, {
	Component,
	type ErrorInfo,
	type ReactNode,
	StrictMode,
} from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './App.css';

class ErrorBoundary extends Component<
	{ children: ReactNode },
	{ error: Error | null }
> {
	override state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[ErrorBoundary]', error, info.componentStack);
	}

	override render() {
		if (this.state.error) {
			return (
				<div style={{ padding: 24, fontFamily: 'monospace', color: '#ef4444' }}>
					<h1>DBSP GUI — Render Error</h1>
					<pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
						{this.state.error.message}
					</pre>
					<pre
						style={{
							whiteSpace: 'pre-wrap',
							marginTop: 8,
							fontSize: 12,
							color: '#888',
						}}
					>
						{this.state.error.stack}
					</pre>
				</div>
			);
		}
		return this.props.children;
	}
}

console.error('[DBSP] main.tsx executing...');

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Remove boot indicator on successful mount
const bootCheck = document.getElementById('boot-check');

console.error('[DBSP] About to render React tree...');

createRoot(root).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);

// Mark as mounted
if (bootCheck) {
	bootCheck.setAttribute('data-dbsp-mounted', 'true');
	bootCheck.textContent = 'DBSP Boot: React mounted OK';
	bootCheck.style.background = '#16a34a';
	setTimeout(() => bootCheck.remove(), 3000);
}

console.error('[DBSP] React render() called successfully');
