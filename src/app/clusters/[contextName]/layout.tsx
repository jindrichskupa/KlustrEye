import { useParams, Outlet } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { TabBar } from "@/components/tab-bar";
import { ClusterColorProvider } from "@/components/cluster-color-provider";
import { MobileSidebarDrawer } from "@/components/mobile-sidebar-drawer";
import { ClusterShellTerminal } from "@/components/cluster-shell-terminal";
import { AiChatPanel } from "@/components/ai-chat-panel";
import { useUIStore } from "@/lib/stores/ui-store";
import { useClusterInfo } from "@/hooks/use-clusters";

export default function ClusterLayout() {
  const { contextName = "" } = useParams();
  const decodedContext = decodeURIComponent(contextName);
  const { namespaceByCluster } = useUIStore();
  const namespace = namespaceByCluster[decodedContext];
  const { data: clusterInfo } = useClusterInfo(decodedContext);

  const aiContext = {
    cluster: decodedContext,
    cluster_display_name: (clusterInfo as { displayName?: string | null } | undefined)?.displayName || undefined,
    namespace: namespace || undefined,
  };

  return (
    <ClusterColorProvider contextName={decodedContext}>
      <div className="flex h-full overflow-hidden">
        <div className="hidden md:flex">
          <Sidebar contextName={decodedContext} />
        </div>
        <MobileSidebarDrawer contextName={decodedContext} />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Header contextName={decodedContext} />
          <TabBar contextName={decodedContext} />
          <main className="flex-1 overflow-auto p-4">
            <Outlet />
          </main>
          <ClusterShellTerminal contextName={decodedContext} />
        </div>
        <AiChatPanel context={aiContext} />
      </div>
    </ClusterColorProvider>
  );
}
