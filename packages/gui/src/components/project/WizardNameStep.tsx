/**
 * Step 2 — Name & Location: project name + folder path.
 */
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface WizardNameStepProps {
	name: string;
	folderPath: string;
	onNameChange: (name: string) => void;
	onFolderPathChange: (path: string) => void;
}

export function WizardNameStep({
	name,
	folderPath,
	onNameChange,
	onFolderPathChange,
}: WizardNameStepProps) {
	const handleBrowse = async () => {
		const selected = await openDialog({
			directory: true,
			multiple: false,
			title: 'Choose project folder',
		});
		if (typeof selected === 'string') {
			onFolderPathChange(selected);
			// Auto-derive name from folder if name is empty
			if (!name.trim()) {
				const folderName = selected.split(/[/\\]/).pop();
				if (folderName) {
					onNameChange(folderName);
				}
			}
		}
	};

	return (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Name & Location</h3>
			<p className="text-muted-foreground text-sm">
				Choose a name for your project and select the folder that contains (or
				will contain) your .dbsp files.
			</p>

			<div className="space-y-3 pt-2">
				<div className="grid gap-1.5">
					<Label htmlFor="project-name">Project name</Label>
					<Input
						id="project-name"
						placeholder="my-project"
						value={name}
						onChange={(e) => onNameChange(e.target.value)}
						autoFocus
					/>
					<p className="text-muted-foreground text-xs">
						Used as display name and storage folder identifier.
					</p>
				</div>

				<div className="grid gap-1.5">
					<Label htmlFor="project-folder">Folder</Label>
					<div className="flex gap-2">
						<Input
							id="project-folder"
							placeholder="/path/to/project"
							value={folderPath}
							onChange={(e) => onFolderPathChange(e.target.value)}
							className="flex-1"
						/>
						<Button
							type="button"
							variant="outline"
							onClick={handleBrowse}
							data-testid="browse-folder"
						>
							Browse...
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						A dbsp.settings.json will be created in this folder.
					</p>
				</div>
			</div>
		</div>
	);
}
