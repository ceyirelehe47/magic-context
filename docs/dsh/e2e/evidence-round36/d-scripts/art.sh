#!/bin/bash
# art.sh RUN_ID -> /workspace/work/r36d/art/<rid>/<artifact-name>/
RID=$1; O="owner=ceyirelehe47 repo=magic-context"
D=/workspace/work/r36d/art/$RID; mkdir -p $D; cd $D
apicall github workflow_run_artifacts_list $O run_id=$RID | jq -r '.artifacts[]|"\(.id) \(.name) \(.expired)"' | while read AID NAME EXP; do
  [ -d "$NAME" ] && { echo "$NAME cached"; continue; }
  curl -sS -L -o a.zip https://api.github.com/repos/ceyirelehe47/magic-context/actions/artifacts/$AID/zip && mkdir -p "$NAME" && (cd "$NAME" && unzip -qo ../a.zip) && rm a.zip && echo "$NAME ok $(du -sh $NAME|cut -f1)"
done
