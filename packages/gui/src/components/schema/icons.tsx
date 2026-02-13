import {
	Key,
	Link,
	Hash,
	Type,
	Calendar,
	ToggleLeft,
	Braces,
	FileJson,
	HelpCircle,
	Fingerprint,
} from "lucide-react";
import type { ComponentType } from "react";

interface IconProps {
	className?: string;
}

/** Map column types to appropriate icons */
const TYPE_ICONS: Record<string, ComponentType<IconProps>> = {
	string: Type,
	number: Hash,
	boolean: ToggleLeft,
	datetime: Calendar,
	json: FileJson,
	jsonb: Braces,
	uuid: Fingerprint,
};

export function TypeIcon({
	type,
	className = "h-3.5 w-3.5",
}: { type: string; className?: string }) {
	const Icon = TYPE_ICONS[type] ?? HelpCircle;
	return <Icon className={className} />;
}

export function PkIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
	return <Key className={`${className} text-amber-500`} />;
}

export function FkIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
	return <Link className={`${className} text-blue-500`} />;
}
