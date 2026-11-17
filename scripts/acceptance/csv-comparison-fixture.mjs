// FR-CON-006/007/012: deterministic files for an actual customer browser journey.
export const comparisonSheet="Comparison Projects";
export const comparisonScreenshots=Object.freeze(["csv-comparison-rename.png","csv-comparison-move.png","csv-comparison-changed.png","csv-comparison-saved.png"]);
export function comparisonFiles(projectId,movedProjectId) {
  const csv=(aProject,aKey,aValue,bNote="comparison-private-b")=>
    "Issue ID,Project ID,Forecast,Private Note\n"+
    `${aKey},${aProject},${aValue},comparison-private-a\n`+
    `COMPARE-B,${projectId},2027-04-15,${bNote}\n`;
  return {
    prior:csv(projectId,"COMPARE-A","2027-03-01"),
    rename:csv(projectId,"COMPARE-RENAMED","2027-03-01"),
    move:csv(movedProjectId,"COMPARE-A","2027-03-01"),
    changed:csv(projectId,"COMPARE-A","2027-03-02","comparison-private-unmapped-change"),
  };
}
