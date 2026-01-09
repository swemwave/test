import { createMinimap } from "./minimap.js";
import { createNav3D } from "./nav3d.js";

async function main() {
  const tour = await (await fetch("./scenedata/tour.json")).json();
  const viewer = pannellum.viewer("panorama", tour);

  const minimap = await createMinimap({
    canvas: document.getElementById("miniCanvas"),
    nodesUrl: "./scenedata/nodes.csv",
    edgesUrl: "./scenedata/edges.csv",
    manualEdgesUrl: "./scenedata/manual_edges.csv",
    scenesUrl: "./scenedata/scenes.csv",
    onNodeClick: (sceneKey) => viewer.loadScene(sceneKey),
  });

  viewer.on("scenechange", (sceneKey) => {
    minimap.setSelectedByScene(sceneKey);
  });

  await createNav3D({
    viewer,
    nodesUrl: "./scenedata/nodes.csv",
    edgesUrl: "./scenedata/edges.csv",
    manualEdgesUrl: "./scenedata/manual_edges.csv",
    scenesUrl: "./scenedata/scenes.csv",
  });
}

main();
