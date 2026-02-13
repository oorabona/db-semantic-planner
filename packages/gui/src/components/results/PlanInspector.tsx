/**
 * Plan inspector: visual display of PlanReport data.
 * Renders metadata, decisions, warnings, and CTEs in a structured layout.
 */
import { CteList } from '@/components/results/CteList';
import { DecisionCard } from '@/components/results/DecisionCard';
import { PlanMetadata } from '@/components/results/PlanMetadata';
import { WarningCard } from '@/components/results/WarningCard';

interface PlanDecision {
	type: string;
	choice: string;
	reasoning: string;
	alternatives: readonly string[];
	context: {
		sourceTable: string;
		target?: string | undefined;
		relation?: string | undefined;
	};
}

interface PlanWarning {
	code: string;
	message: string;
	suggestion?: string | undefined;
}

interface CteItem {
	name: string;
	purpose: string;
	referencedBy: readonly string[];
	recursive?: boolean | undefined;
}

interface PlanData {
	rootTable?: string | undefined;
	decisions?: readonly PlanDecision[] | undefined;
	warnings?: readonly PlanWarning[] | undefined;
	ctes?: readonly CteItem[] | undefined;
	metadata?: {
		planningTimeMs?: number | undefined;
		relationsAnalyzed?: number | undefined;
		isAmbiguous?: boolean | undefined;
	} | undefined;
}

interface PlanInspectorProps {
	plan: unknown;
}

function isPlanData(value: unknown): value is PlanData {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function PlanInspector({ plan }: PlanInspectorProps) {
	if (!isPlanData(plan)) {
		return (
			<pre className="whitespace-pre-wrap font-mono text-xs">
				{JSON.stringify(plan, null, 2)}
			</pre>
		);
	}

	const {
		rootTable,
		decisions = [],
		warnings = [],
		ctes = [],
		metadata,
	} = plan;

	const hasContent =
		rootTable || decisions.length > 0 || warnings.length > 0 || ctes.length > 0;

	if (!hasContent) {
		return (
			<pre className="whitespace-pre-wrap font-mono text-xs">
				{JSON.stringify(plan, null, 2)}
			</pre>
		);
	}

	return (
		<div className="space-y-4">
			{rootTable && (
				<PlanMetadata
					rootTable={rootTable}
					planningTimeMs={metadata?.planningTimeMs ?? 0}
					relationsAnalyzed={metadata?.relationsAnalyzed ?? 0}
					isAmbiguous={metadata?.isAmbiguous}
				/>
			)}

			{warnings.length > 0 && (
				<section className="space-y-1.5">
					<h4 className="text-xs font-medium text-muted-foreground">
						Warnings ({warnings.length})
					</h4>
					{warnings.map((w, i) => (
						<WarningCard
							key={`${w.code}-${i}`}
							code={w.code}
							message={w.message}
							suggestion={w.suggestion}
						/>
					))}
				</section>
			)}

			{decisions.length > 0 && (
				<section className="space-y-1.5">
					<h4 className="text-xs font-medium text-muted-foreground">
						Decisions ({decisions.length})
					</h4>
					{decisions.map((d, i) => (
						<DecisionCard
							key={`${d.type}-${i}`}
							type={d.type}
							choice={d.choice}
							reasoning={d.reasoning}
							alternatives={d.alternatives}
							context={d.context}
						/>
					))}
				</section>
			)}

			{ctes.length > 0 && <CteList ctes={ctes} />}
		</div>
	);
}
