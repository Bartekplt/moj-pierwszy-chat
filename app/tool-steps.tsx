import { chatToolLabels, type ChatMessage } from "../lib/chat";

export default function ToolSteps({ metadata }: { metadata: ChatMessage["metadata"] }) {
  const steps = metadata?.toolSteps ?? metadata?.usedTools?.map((tool, index) => ({ step: index + 1, tools: [tool] }));
  if (!steps?.length) return null;

  return (
    <ol className="tool-badges" aria-label="Kroki agenta i użyte narzędzia" role="list">
      {steps.map(({ step, tools }, index) => (
        <li className="tool-step" key={step}>
          <span className="tool-badge">{step}. {tools.map((name) => chatToolLabels[name]).join(", ")}</span>
          {index < steps.length - 1 && <span aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}
