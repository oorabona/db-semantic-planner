import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface PasswordPromptProps {
	readonly open: boolean;
	readonly profileName: string;
	readonly onSubmit: (password: string) => void;
	readonly onCancel: () => void;
	readonly error?: string | null;
	readonly connecting?: boolean;
}

export function PasswordPrompt({
	open,
	profileName,
	onSubmit,
	onCancel,
	error,
	connecting,
}: PasswordPromptProps) {
	const [password, setPassword] = useState('');

	// F-007: clear stale password when dialog closes
	useEffect(() => {
		if (!open) setPassword('');
	}, [open]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onSubmit(password);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) onCancel();
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Password Required</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit}>
					<div className="space-y-4 py-4">
						<p className="text-sm text-muted-foreground">
							Enter password for{' '}
							<span className="font-medium">{profileName}</span>
						</p>
						<div className="space-y-2">
							<Label htmlFor="pwd-prompt-input">Password</Label>
							<Input
								id="pwd-prompt-input"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoFocus
								disabled={connecting}
							/>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
							disabled={connecting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!password || connecting}>
							{connecting ? 'Connecting…' : 'Connect'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
