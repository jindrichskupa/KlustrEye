

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/yaml-editor";
import { useCreateResource } from "@/hooks/use-resources";
import { useToast } from "@/components/ui/toast";
import type { ResourceKind } from "@/lib/constants";
import { RESOURCE_REGISTRY } from "@/lib/constants";
import { parse } from "yaml";
import { Sparkles, Loader2 } from "lucide-react";

const DEFAULT_TEMPLATES: Partial<Record<ResourceKind, string>> = {
  pods: `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  namespace: default
spec:
  containers:
    - name: main
      image: nginx:latest
      ports:
        - containerPort: 80`,
  deployments: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deployment
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: main
          image: nginx:latest
          ports:
            - containerPort: 80`,
  services: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP`,
  configmaps: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key: value`,
  statefulsets: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-statefulset
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  serviceName: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: main
          image: nginx:latest
          ports:
            - containerPort: 80`,
  daemonsets: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-daemonset
  namespace: default
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: main
          image: nginx:latest`,
  jobs: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: default
spec:
  template:
    spec:
      containers:
        - name: main
          image: busybox
          command: ["echo", "Hello"]
      restartPolicy: Never
  backoffLimit: 4`,
  cronjobs: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
  namespace: default
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: main
              image: busybox
              command: ["echo", "Hello"]
          restartPolicy: Never`,
  ingresses: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: default
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80`,
  secrets: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
stringData:
  key: value`,
  persistentvolumeclaims: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi`,
};

interface CreateResourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextName: string;
  kind: ResourceKind;
  namespace?: string;
}

export function CreateResourceDialog({
  open,
  onOpenChange,
  contextName,
  kind,
  namespace,
}: CreateResourceDialogProps) {
  const entry = RESOURCE_REGISTRY[kind];
  const defaultYaml = DEFAULT_TEMPLATES[kind] || `apiVersion: ${entry.apiVersion}\nkind: ${entry.kind}\nmetadata:\n  name: my-resource\n  namespace: ${namespace || "default"}`;
  const [yaml, setYaml] = useState(defaultYaml);
  const createMutation = useCreateResource(contextName, kind);
  const { addToast } = useToast();

  // Generate with AI state
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState('');
  const [generateOutput, setGenerateOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [extractedYaml, setExtractedYaml] = useState<string | null>(null);

  function extractYamlBlock(text: string): string | null {
    const match = text.match(/```(?:yaml|yml)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : null;
  }

  async function handleGenerate() {
    if (!generatePrompt.trim() || generating) return;
    setGenerating(true);
    setGenerateOutput('');
    setExtractedYaml(null);

    const kindLabel = entry.label;
    const systemPrompt = `Generate a Kubernetes ${kindLabel} YAML manifest for: ${generatePrompt}`;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: systemPrompt }],
          context: {},
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setGenerateOutput(`Error: ${err.error ?? 'Request failed'}`);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const frame = JSON.parse(data);
              if (frame.error) {
                setGenerateOutput(prev => prev + `\nError: ${frame.error}`);
                break outer;
              }
              if (frame.delta) {
                accumulated += frame.delta;
                setGenerateOutput(accumulated);
                const extractedBlock = extractYamlBlock(accumulated);
                if (extractedBlock) setExtractedYaml(extractedBlock);
              }
              if (frame.done) break outer;
            } catch {
              // ignore malformed frame
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setGenerateOutput(`Error: ${msg}`);
    } finally {
      setGenerating(false);
    }
  }

  function handleUseYaml() {
    if (!extractedYaml) return;
    const hasCustomContent = yaml.trim() !== '' && yaml !== defaultYaml;
    if (hasCustomContent) {
      if (!window.confirm('Replace current YAML with the generated content?')) return;
    }
    setYaml(extractedYaml);
    setGenerateOpen(false);
    setGenerateOutput('');
    setExtractedYaml(null);
    setGeneratePrompt('');
  }

  const handleCreate = async () => {
    try {
      const body = parse(yaml);
      const ns = body.metadata?.namespace || namespace;
      await createMutation.mutateAsync({ body, namespace: ns });
      addToast({ title: `${entry.label} created`, variant: "success" });
      onOpenChange(false);
    } catch (err) {
      addToast({ title: "Create failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>Create {entry.label}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setGenerateOpen(v => !v)}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Generate with AI
          </Button>
        </div>
        {generateOpen && (
          <div className="space-y-2 border rounded-md p-3 bg-muted/30">
            <div className="flex gap-2">
              <input
                className="flex-1 text-sm border rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={`Describe the ${entry.label} you want to create...`}
                value={generatePrompt}
                onChange={e => setGeneratePrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleGenerate(); }}
                disabled={generating}
                autoComplete="off"
              />
              <Button
                size="sm"
                type="button"
                onClick={handleGenerate}
                disabled={!generatePrompt.trim() || generating}
              >
                {generating ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Generating...</>
                ) : 'Generate'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => { setGenerateOpen(false); setGenerateOutput(''); setExtractedYaml(null); }}
              >
                Cancel
              </Button>
            </div>
            {generateOutput && (
              <div className="space-y-2">
                <textarea
                  className="w-full min-h-[120px] text-xs font-mono border rounded-md p-2 bg-background resize-y"
                  value={generateOutput}
                  readOnly
                />
                {extractedYaml && (
                  <Button size="sm" type="button" onClick={handleUseYaml}>
                    Use this YAML
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="border rounded-md overflow-hidden">
          <YamlEditor value={yaml} onChange={setYaml} height="400px" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
