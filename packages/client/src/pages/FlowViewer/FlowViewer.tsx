import { Dialog, DialogActions, DialogTitle } from "@mui/material";
import Drawer from "components/Drawer";
import { GenericButton, Select } from "components/Elements";
import { getFlow } from "pages/FlowBuilder/FlowHelpers";
import { v4 as uuid } from "uuid";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import ReactFlow, {
  Background,
  ConnectionLineType,
  Node,
  Edge,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
} from "react-flow-renderer";
import { useParams } from "react-router-dom";
import ViewNode from "./ViewNode";
import ApiService from "services/api.service";
import { ApiConfig } from "./../../constants";
import TriggerModal from "pages/FlowBuilder/TriggerModal";
import Tooltip from "components/Elements/Tooltip";
import Header from "components/Header";

const Flow = () => {
  const { name } = useParams();
  const [flowId, setFlowId] = useState<string>("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [triggers, setTriggers] = useState<any>([]);
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [isPaused, setIsPaused] = useState(false);
  const [isStopped, setIsStopped] = useState(false);
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedTrigger, setSelectedTrigger] = useState<any>(undefined);
  const [triggerModalOpen, settriggerModalOpen] = useState<boolean>(false);

  const onTriggerSelect = (e: any, triggerId: any, triggersList: any) => {
    const trigger = triggersList.find((item: any) => item.id === triggerId);
    setSelectedTrigger(trigger);
    settriggerModalOpen(true);
  };

  const handleTriggerModalOpen = (e: any) => {
    settriggerModalOpen(!triggerModalOpen);
  };

  const onSaveTrigger = (data: any) => {
    settriggerModalOpen(false);
    selectedTrigger.properties = data;
  };

  const onDeleteTrigger = (data: any) => {
    const selectedNodeData = nodes.find((node) =>
      node.data.triggers.find((item: any) => item.id === data)
    );
    const newTriggersData: any = selectedNodeData?.data?.triggers.filter(
      (item: any) => item.id !== data
    );
    if (selectedNodeData !== undefined) {
      selectedNodeData.data.triggers = newTriggersData;
      setNodes([...nodes]);
      setEdges(edges.filter((edge) => edge.sourceHandle !== data));
      settriggerModalOpen(false);
    }
  };

  useLayoutEffect(() => {
    const populateFlowBuilder = async () => {
      const { data } = await getFlow(name, true);
      setFlowId(data.id);
      setIsPaused(data.isPaused);
      setIsStopped(data.isStopped);
      if (data.visualLayout) {
        const updatedNodes = data.visualLayout.nodes.map((item: any) => {
          return {
            ...item,
            data: {
              ...item.data,
              onTriggerSelect,
            },
          };
        });
        setNodes(updatedNodes);
        setEdges(data.visualLayout.edges);
      }
    };
    populateFlowBuilder();
    setIsDataLoaded(true);
  }, []);

  const onNodesChange = () => {};

  useEffect(() => {
    const filteredNewNodes = nodes.filter((node) => node.data.isNew);
    if (filteredNewNodes.length) {
      const edgeData: Edge[] = [];
      for (let i = 0; i < filteredNewNodes.length; i++) {
        edgeData.push({
          id: uuid(),
          source: selectedNode,
          target: filteredNewNodes[i].id,
          markerEnd: {
            type: MarkerType.Arrow,
            strokeWidth: 2,
            height: 20,
            width: 20,
          },
          type: ConnectionLineType.SmoothStep,
        });
      }

      setEdges([...edges, ...edgeData]);

      const removedIsNewNodes = nodes.map((node) => {
        delete node?.data?.isNew;
        return node;
      });
      setNodes(removedIsNewNodes);
    }
  }, [nodes]);

  const onNodeDragStart = () => {};

  const onEdgesChange = () => {};

  const onConnect = () => {};

  const onClickConnectionStart = () => {};

  const onNodeDoubleClick = () => {};

  const onConnectStart = () => {};

  const onConnectEnd = () => {};

  const handleDialogClose = () => {
    setIsDialogOpen(false);
  };

  const handleDialogOpen = () => {
    setIsDialogOpen(true);
  };

  const handlePause = async () => {
    try {
      setIsDataLoaded(false);
      await ApiService.patch({
        url: `${ApiConfig.flow}/pause`,
        options: { id: flowId },
      });
      setIsPaused(!isPaused);
      setIsDataLoaded(true);
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleResume = async () => {
    try {
      setIsDataLoaded(false);
      await ApiService.patch({
        url: `${ApiConfig.flow}/resume`,
        options: { id: flowId },
      });
      setIsPaused(!isPaused);
      setIsDataLoaded(true);
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleStop = async () => {
    try {
      setIsDataLoaded(false);
      await ApiService.patch({
        url: `${ApiConfig.flow}/stop`,
        options: { id: flowId },
      });
      setIsStopped(!isStopped);
      setIsDataLoaded(true);
      setIsDialogOpen(false);
    } catch (e: any) {
      console.error(e);
    }
  };

  const onPaneClick = useCallback((event: React.MouseEvent) => {
    setSelectedNode("");
  }, []);

  const rfStyle = {
    backgroundColor: "rgba(112,112,112, 0.06)",
  };

  const nodeTypes = useMemo(() => ({ special: ViewNode }), [triggers]);
  const { setViewport } = useReactFlow();
  const { x: viewX, y: viewY } = useViewport();
  const [zoomState, setZoomState] = useState(1);
  const possibleViewZoomValues = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  return (
    <div className="h-[100vh] flex w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={onPaneClick}
        onNodeDragStart={onNodeDragStart}
        onClickConnectStart={onClickConnectionStart}
        connectionLineType={ConnectionLineType.SmoothStep}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        style={rfStyle}
        nodeTypes={nodeTypes}
        zoomOnScroll={false}
        zoomOnPinch={false}
        defaultZoom={1}
        zoomOnDoubleClick={false}
      >
        <div
          style={{
            position: "absolute",
            zIndex: "111",
            display: "flex",
            right: "15px",
            inset: " 20px 20px auto auto",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div className="p-[0px_7.5px]" data-saveflowbutton>
            <Tooltip
              title={
                !isPaused && isDataLoaded && !isStopped
                  ? "Users won't move between steps or get messages temporarily"
                  : ""
              }
            >
              <GenericButton
                onClick={isPaused ? handleResume : handlePause}
                style={{
                  maxWidth: "158px",
                  maxHeight: "48px",
                  padding: "13px 25px",
                }}
                disabled={!isDataLoaded || isStopped}
              >
                {isPaused ? "Resume" : "Pause"}
              </GenericButton>
            </Tooltip>
          </div>
          <div className="p-[0px_7.5px]" data-startflowbutton>
            <Tooltip
              title={
                !isDataLoaded && !isStopped
                  ? ""
                  : "Once you stop a journey no more messages are sent, and users don't move steps"
              }
            >
              <GenericButton
                onClick={handleDialogOpen}
                style={{
                  maxWidth: "158px",
                  maxHeight: "48px",
                  padding: "13px 25px",
                }}
                disabled={!isDataLoaded || isStopped}
              >
                Stop
              </GenericButton>
            </Tooltip>
          </div>
          <Dialog
            open={isDialogOpen}
            onClose={handleDialogClose}
            aria-labelledby="alert-dialog-title"
            aria-describedby="alert-dialog-description"
          >
            <DialogTitle id="alert-dialog-title">
              {"Are you sure you want to stop this journey?"}
            </DialogTitle>
            <DialogActions>
              <GenericButton
                onClick={handleDialogClose}
                style={{
                  maxWidth: "158px",
                  maxHeight: "48px",

                  "background-image":
                    "linear-gradient(to right, #bbbbbb , #b4b4b4, #686868)",
                  padding: "13px 25px",
                }}
              >
                No
              </GenericButton>
              <GenericButton
                onClick={handleStop}
                style={{
                  maxWidth: "158px",
                  maxHeight: "48px",
                  padding: "13px 25px",
                }}
              >
                Yes
              </GenericButton>
            </DialogActions>
          </Dialog>
          <Select
            id="zoomSelect"
            value={zoomState}
            options={possibleViewZoomValues.map((item) => ({
              value: item,
              title: item * 100 + "%",
            }))}
            onChange={(e) => {
              setZoomState(+e.target.value);
              setViewport({ x: viewX, y: viewY, zoom: +e.target.value });
            }}
            sx={{ margin: "0 7.5px" }}
          />
        </div>
        <Background size={0} />
      </ReactFlow>
      {triggerModalOpen && (
        <TriggerModal
          selectedTrigger={selectedTrigger}
          onSaveTrigger={onSaveTrigger}
          onDeleteTrigger={onDeleteTrigger}
          isCollapsible={true}
          isViewMode={true}
          onClose={() => settriggerModalOpen(false)}
        />
      )}
    </div>
  );
};

const FlowViewer = () => {
  return (
    <>
      <Header />
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
    </>
  );
};

export default FlowViewer;
