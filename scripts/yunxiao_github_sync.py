from __future__ import annotations

import argparse
import json
import os
import sys
import time

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


SOURCE_LABELS = {"issue": "Issue", "pr": "PR"}
# Yunxiao projects can customize workflow names. Keep the canonical names used
# by the sync state machine, then resolve them to the first matching name in
# the target project's workflow.
STATUS_ALIASES = {
    "待处理": ("待处理", "未开始"),
    "已完成": ("已完成", "开发完成", "完成"),
    "已取消": ("已取消", "已关闭", "关闭"),
}
DEFAULT_PRIORITY_NAME = "中"
DEFAULT_WORKITEM_CATEGORY = "Req"
DEFAULT_WORKITEM_TYPE_NAME = "需求"
DEFAULT_DAYS_TO_FINISH = 7
DEFAULT_PARTICIPANT_NAMES = ("徐之淇", "贾澄臻")
# GitHub exposes the relationship between a pull-request author and the
# repository. Only community-facing associations enter the Yunxiao space.
EXTERNAL_PR_AUTHOR_ASSOCIATIONS = frozenset(
    {
        "CONTRIBUTOR",
        "FIRST_TIMER",
        "FIRST_TIME_CONTRIBUTOR",
        "NONE",
    }
)
REQUIRED_ENV = (
    "YUNXIAO_PROJECT_ID",
    "YUNXIAO_PROJECT_NAME",
)


class PreflightError(ValueError):
    pass


class YunxiaoApiError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PreflightError(f"缺少必需的环境变量：{name}（请在仓库 Variables 中配置）")
    return value


class UrllibTransport:
    def __init__(
        self,
        token: str,
        *,
        base_url: str = "https://openapi-rdc.aliyuncs.com",
        timeout_seconds: int = 30,
    ) -> None:
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    def __call__(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-yunxiao-token": self._token,
            },
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                payload = response.read().decode()
            if not payload.strip():
                return None
            return json.loads(payload)
        except HTTPError as error:
            raise YunxiaoApiError(
                f"云效 API HTTP {error.code}: {error.read().decode(errors='replace')[:300]}"
            ) from error
        except URLError as error:
            raise YunxiaoApiError(f"无法连接云效 API：{error.reason}") from error


def repository_name(repository: str | None = None) -> str:
    value = (repository or os.environ.get("GITHUB_REPOSITORY", "")).strip()
    if not value or "/" not in value:
        raise PreflightError("缺少有效的 GitHub 仓库标识，要求格式为 owner/repository")
    return value


def build_source_key(
    item_type: str,
    item: dict[str, Any],
    repository: str | None = None,
) -> str:
    return f"[GitHub {repository_name(repository)} {SOURCE_LABELS[item_type]} #{item['number']}]"


def build_title(
    item_type: str,
    item: dict[str, Any],
    repository: str | None = None,
) -> str:
    return f"{build_source_key(item_type, item, repository)} {item['title']}"


def iso_after_days(value: str, days: int) -> str:
    created_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (
        (created_at + timedelta(days=days))
        .astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def source_status(item_type: str, item: dict[str, Any]) -> str:
    if item.get("state") == "open":
        return "待处理"
    if item_type == "pr" and (item.get("merged") or item.get("merged_at")):
        return "已完成"
    return "已取消"


def should_sync_pull_request(item: dict[str, Any]) -> bool:
    """Return whether a pull request was submitted by a community user."""
    association = str(item.get("author_association") or "").strip().upper()
    return association in EXTERNAL_PR_AUTHOR_ASSOCIATIONS


def item_id(item: dict[str, Any]) -> str:
    for key in ("id", "identifier", "organizationId", "userId", "statusId", "value"):
        value = item.get(key)
        if value:
            return str(value)
    raise PreflightError(f"云效对象缺少 id：{item}")


def item_name(item: dict[str, Any]) -> str | None:
    for key in ("name", "displayName", "userName", "displayValue", "statusName"):
        value = item.get(key)
        if isinstance(value, str):
            return value
    return None


def list_or_extract(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        for key in (*keys, "items"):
            value = payload.get(key)
            if isinstance(value, list) and all(isinstance(x, dict) for x in value):
                return value
    if isinstance(payload, list) and all(isinstance(x, dict) for x in payload):
        return payload
    return []


def find_by_name(items: list[dict[str, Any]], name: str, label: str) -> dict[str, Any]:
    for item in items:
        if item_name(item) == name:
            return item
    raise PreflightError(f"未在云效中找到{label}：{name}")


def resolve_statuses(workflow: list[dict[str, Any]]) -> dict[str, str]:
    names = {
        name: item
        for item in workflow
        if (name := item_name(item))
    }
    statuses: dict[str, str] = {}
    for canonical, aliases in STATUS_ALIASES.items():
        matched_name = next((name for name in aliases if name in names), None)
        if matched_name is None:
            supported = "、".join(sorted(names)) or "（空）"
            raise PreflightError(
                f"未在云效中找到工作流状态：{canonical}；"
                f"支持的别名：{'、'.join(aliases)}；当前状态：{supported}"
            )
        statuses[canonical] = item_id(names[matched_name])
    return statuses


class YunxiaoClient:
    def __init__(self, transport: Any) -> None:
        self.transport = transport

    def get(self, path: str) -> Any:
        return self.transport("GET", path)


def preflight(
    project_id: str,
    project_name: str,
    assignee_name: str | None,
    client: YunxiaoClient,
    *,
    workitem_category: str = DEFAULT_WORKITEM_CATEGORY,
    workitem_type_name: str = DEFAULT_WORKITEM_TYPE_NAME,
    priority_name: str = DEFAULT_PRIORITY_NAME,
    parent_id: str | None = None,
    sprint_id: str | None = None,
    participant_names: tuple[str, ...] = DEFAULT_PARTICIPANT_NAMES,
) -> dict[str, Any]:
    organizations = list_or_extract(client.get("/oapi/v1/platform/organizations"), ())
    if not organizations:
        raise PreflightError("PAT 无法访问任何云效组织")

    for organization in organizations:
        organization_id = item_id(organization)
        project = client.get(
            f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}"
        )
        if isinstance(project, dict) and project.get("name") == project_name:
            org = organization_id
            break
    else:
        raise PreflightError(f"未找到项目：{project_name}（{project_id}）")

    encoded_category = quote(workitem_category, safe="")
    types = list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}"
            f"/workitemTypes?category={encoded_category}"
        ),
        ("workitemTypes",),
    )
    workitem_type = next(
        (value for value in types if item_name(value) == workitem_type_name),
        None,
    )
    if workitem_type is None:
        workitem_type = next(
            (
                value
                for value in types
                if value.get("categoryId", value.get("category")) == workitem_category
            ),
            None,
        )
    if not workitem_type:
        raise PreflightError(
            f"目标项目没有工作项类型：{workitem_type_name}（category={workitem_category}）"
        )
    type_id = item_id(workitem_type)

    assignee_id = ""
    participant_ids: list[str] = []
    if assignee_name or participant_names:
        members = list_or_extract(
            client.get(f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/members"),
            ("members",),
        )
        if assignee_name:
            assignee_id = item_id(find_by_name(members, assignee_name, "默认负责人"))
        for participant_name in participant_names:
            participant_id = item_id(find_by_name(members, participant_name, "默认参与者"))
            if participant_id not in participant_ids:
                participant_ids.append(participant_id)

    workflow = list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}"
            f"/workitemTypes/{type_id}/workflows"
        ),
        ("statuses", "workflowStatuses"),
    )
    statuses = resolve_statuses(workflow)

    fields = list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}"
            f"/workitemTypes/{type_id}/fields"
        ),
        ("fields", "fieldConfigs"),
    )
    priority_field = next(
        (
            field
            for field in fields
            if field.get("id") == "priority"
            or field.get("identifier") == "priority"
            or field.get("fieldIdentifier") == "priority"
        ),
        None,
    )
    if not priority_field:
        raise PreflightError("工作项类型缺少优先级字段")
    options = list_or_extract(
        priority_field.get("options") or priority_field.get("values") or {},
        (),
    )
    if not options:
        options = priority_field.get("options") or priority_field.get("values") or []
    priority = find_by_name(options, priority_name, "默认优先级")

    return {
        "org": org,
        "project_id": project_id,
        "workitem_category": workitem_category,
        "type_id": type_id,
        "type_name": item_name(workitem_type) or workitem_type_name,
        "assignee_id": assignee_id,
        "participant_ids": participant_ids,
        "priority_id": item_id(priority),
        "statuses": statuses,
        "parent_id": parent_id or "",
        "sprint_id": sprint_id or "",
    }


def sync_labels(
    org: str,
    project_id: str,
    wanted: set[str],
    client: YunxiaoClient,
) -> dict[str, str]:
    existing_raw = client.get(
        f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/labels"
    )
    existing_names: set[str] = set()
    name_to_id: dict[str, str] = {}
    for label in list_or_extract(existing_raw, ()):
        name = item_name(label) or label.get("name", "")
        if name:
            existing_names.add(name)
            name_to_id[name] = item_id(label)

    colors = [
        "#e91e63",
        "#9c27b0",
        "#673ab7",
        "#3f51b5",
        "#2196f3",
        "#00bcd4",
        "#009688",
        "#4caf50",
        "#8bc34a",
        "#cddc39",
        "#ffc107",
        "#ff9800",
        "#ff5722",
    ]
    for index, name in enumerate(sorted(wanted - existing_names)):
        try:
            response = client.transport(
                "POST",
                f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/labels",
                {"name": name, "color": colors[index % len(colors)]},
            )
            name_to_id[name] = item_id(response)
            time.sleep(0.1)
        except YunxiaoApiError:
            # A concurrent workflow may have created the same label.
            pass
    return name_to_id


def find_workitem(
    org: str,
    project_id: str,
    prefix: str,
    client: YunxiaoClient,
    *,
    category: str = DEFAULT_WORKITEM_CATEGORY,
) -> str | None:
    conditions = json.dumps(
        {
            "conditionGroups": [
                [
                    {
                        "fieldIdentifier": "subject",
                        "operator": "CONTAINS",
                        "value": [prefix],
                        "className": "string",
                        "format": "input",
                    }
                ]
            ]
        },
        ensure_ascii=False,
    )
    response = client.transport(
        "POST",
        f"/oapi/v1/projex/organizations/{org}/workitems:search",
        {"spaceId": project_id, "category": category, "conditions": conditions},
    )
    data = (
        response
        if isinstance(response, list)
        else (response or {}).get("data", response)
        if isinstance(response, dict)
        else response
    )
    items = (
        (data.get("workitems", data.get("items", [])) if isinstance(data, dict) else data)
        if data
        else []
    )
    return item_id(items[0]) if items else None


def legacy_source_key(item_type: str, item: dict[str, Any]) -> str:
    return f"[GitHub {SOURCE_LABELS[item_type]} #{item['number']}]"


def find_existing_workitem(
    org: str,
    project_id: str,
    item_type: str,
    item: dict[str, Any],
    repository: str,
    client: YunxiaoClient,
    *,
    category: str,
) -> str | None:
    current_key = build_source_key(item_type, item, repository)
    existing_id = find_workitem(
        org,
        project_id,
        current_key,
        client,
        category=category,
    )
    if existing_id:
        return existing_id
    # MemOS PR #2159 used a repository-less key. Keep this fallback during
    # migration so a new workflow cannot duplicate those existing work items.
    return find_workitem(
        org,
        project_id,
        legacy_source_key(item_type, item),
        client,
        category=category,
    )


def item_description(item: dict[str, Any]) -> str:
    url = str(item.get("html_url", "")).strip()
    body = str(item.get("body") or "").strip()
    if body:
        return f"GitHub: {url}\n\n{body}"
    return f"GitHub: {url}"


def sync_one(
    org: str,
    cfg: dict[str, Any],
    item_type: str,
    item: dict[str, Any],
    *,
    repository: str,
    apply: bool,
    label_ids: dict[str, str] | None,
    days_to_finish: int,
    create_closed: bool,
    client: YunxiaoClient,
) -> str:
    existing_id = find_existing_workitem(
        org,
        cfg["project_id"],
        item_type,
        item,
        repository,
        client,
        category=cfg["workitem_category"],
    )

    if existing_id:
        if not apply:
            return "dry-run-status"
        status_name = source_status(item_type, item)
        update_payload: dict[str, Any] = {"status": cfg["statuses"][status_name]}
        if cfg.get("sprint_id"):
            update_payload["sprint"] = cfg["sprint_id"]
        if cfg.get("assignee_id"):
            update_payload["assignedTo"] = cfg["assignee_id"]
        if cfg.get("participant_ids"):
            update_payload["participants"] = cfg["participant_ids"]
        client.transport(
            "PUT",
            f"/oapi/v1/projex/organizations/{org}/workitems/{existing_id}",
            update_payload,
        )
        return "updated-status"

    if item.get("state") != "open" and not create_closed:
        return "skipped-closed"
    if not apply:
        return "dry-run-create"

    payload: dict[str, Any] = {
        "spaceId": cfg["project_id"],
        "workitemTypeId": cfg["type_id"],
        "subject": build_title(item_type, item, repository),
        "description": item_description(item),
        "status": cfg["statuses"][source_status(item_type, item)],
        "assignedTo": cfg["assignee_id"],
        "priority": cfg["priority_id"],
        "planStartTime": item["created_at"],
        "planFinishTime": iso_after_days(item["created_at"], days_to_finish),
    }
    if not cfg.get("assignee_id"):
        payload.pop("assignedTo")
    if cfg.get("parent_id"):
        payload["parentId"] = cfg["parent_id"]
    if cfg.get("sprint_id"):
        # Yunxiao's CreateWorkitem API calls the required iteration field
        # "sprint". The value is the Yunxiao sprint/iteration ID.
        payload["sprint"] = cfg["sprint_id"]
    if cfg.get("participant_ids"):
        payload["participants"] = cfg["participant_ids"]

    github_labels = [
        label["name"]
        for label in item.get("labels", [])
        if isinstance(label, dict) and label.get("name")
    ]
    labels = [label_ids[name] for name in github_labels if label_ids and name in label_ids]
    if labels:
        payload["labels"] = labels

    client.transport(
        "POST",
        f"/oapi/v1/projex/organizations/{org}/workitems",
        payload,
    )
    return "created"


def configuration_from_environment(client: YunxiaoClient) -> dict[str, Any]:
    participant_names = tuple(
        name.strip()
        for name in os.environ.get(
            "YUNXIAO_PARTICIPANT_NAMES",
            ",".join(DEFAULT_PARTICIPANT_NAMES),
        ).split(",")
        if name.strip()
    )
    return preflight(
        required_env("YUNXIAO_PROJECT_ID"),
        required_env("YUNXIAO_PROJECT_NAME"),
        os.environ.get("YUNXIAO_DEFAULT_ASSIGNEE_NAME", "").strip() or None,
        client,
        workitem_category=os.environ.get(
            "YUNXIAO_WORKITEM_CATEGORY",
            DEFAULT_WORKITEM_CATEGORY,
        ).strip()
        or DEFAULT_WORKITEM_CATEGORY,
        workitem_type_name=os.environ.get(
            "YUNXIAO_WORKITEM_TYPE_NAME",
            DEFAULT_WORKITEM_TYPE_NAME,
        ).strip()
        or DEFAULT_WORKITEM_TYPE_NAME,
        priority_name=os.environ.get(
            "YUNXIAO_PRIORITY_NAME",
            DEFAULT_PRIORITY_NAME,
        ).strip()
        or DEFAULT_PRIORITY_NAME,
        parent_id=os.environ.get("YUNXIAO_PARENT_ID", "").strip() or None,
        sprint_id=os.environ.get("YUNXIAO_SPRINT_ID", "").strip() or None,
        participant_names=participant_names,
    )


def days_to_finish() -> int:
    raw = os.environ.get("YUNXIAO_DAYS_TO_FINISH", "").strip()
    if not raw:
        return DEFAULT_DAYS_TO_FINISH
    try:
        value = int(raw)
    except ValueError as error:
        raise PreflightError("YUNXIAO_DAYS_TO_FINISH 必须是正整数") from error
    if value < 1:
        raise PreflightError("YUNXIAO_DAYS_TO_FINISH 必须是正整数")
    return value


def handle_event(client: YunxiaoClient) -> int:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        print("缺少 GITHUB_EVENT_PATH", file=sys.stderr)
        return 2
    with open(event_path, encoding="utf-8") as event_file:
        event = json.load(event_file)

    action = event.get("action", "")
    if action not in ("opened", "closed", "reopened"):
        print(f"忽略事件 action={action}", file=sys.stderr)
        return 0

    item = event.get("issue") or event.get("pull_request")
    if not item:
        print("事件中缺少 issue/pull_request", file=sys.stderr)
        return 1

    if event.get("issue") and "pull_request" in event["issue"]:
        print("issue 事件包含 PR 元数据，跳过", file=sys.stderr)
        return 0

    item_type = "pr" if "pull_request" in event else "issue"
    if item_type == "pr" and action == "closed":
        item["merged"] = item.get("merged") or event.get("pull_request", {}).get("merged", False)

    repository = repository_name(
        event.get("repository", {}).get("full_name") or os.environ.get("GITHUB_REPOSITORY")
    )
    if item_type == "pr" and not should_sync_pull_request(item):
        association = str(item.get("author_association") or "").strip().upper() or "UNKNOWN"
        print(
            f"{repository} pr #{item['number']}: skipped internal author_association={association}",
            file=sys.stderr,
        )
        return 0

    cfg = configuration_from_environment(client)
    all_labels = {
        label["name"]
        for label in item.get("labels", [])
        if isinstance(label, dict) and label.get("name")
    }
    label_ids = sync_labels(cfg["org"], cfg["project_id"], all_labels, client) if all_labels else {}
    result = sync_one(
        cfg["org"],
        cfg,
        item_type,
        item,
        repository=repository,
        apply=True,
        label_ids=label_ids,
        days_to_finish=days_to_finish(),
        create_closed=False,
        client=client,
    )
    print(f"{repository} {item_type} #{item['number']}: {result}")
    return 0


def github_collection(
    repository: str,
    path: str,
    *,
    state: str,
    token: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    page = 1
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
    }
    while True:
        query = urlencode({"state": state, "per_page": 100, "page": page})
        request = Request(
            f"https://api.github.com/repos/{repository}/{path}?{query}",
            headers=headers,
        )
        with urlopen(request, timeout=30) as response:
            batch = json.loads(response.read().decode())
        if not isinstance(batch, list) or not batch:
            return result
        result.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < 100:
            return result
        page += 1


def backfill(client: YunxiaoClient, *, apply: bool, state: str) -> int:
    github_token = os.environ.get("GH_TOKEN", "").strip()
    repository = repository_name(os.environ.get("GITHUB_REPOSITORY"))
    issues_raw = github_collection(repository, "issues", state=state, token=github_token)
    prs_raw = github_collection(repository, "pulls", state=state, token=github_token)
    issues = [item for item in issues_raw if "pull_request" not in item]
    prs = [item for item in prs_raw if should_sync_pull_request(item)]
    print(
        f"GitHub: {len(issues)} {state} issues, {len(prs)} external {state} PRs "
        f"(skipped {len(prs_raw) - len(prs)} internal PRs)",
        file=sys.stderr,
    )

    cfg = configuration_from_environment(client)
    all_labels: set[str] = set()
    for item in issues + prs:
        all_labels.update(
            label["name"]
            for label in item.get("labels", [])
            if isinstance(label, dict) and label.get("name")
        )
    label_ids = sync_labels(cfg["org"], cfg["project_id"], all_labels, client) if all_labels else {}

    summary: dict[str, Any] = {}
    for kind, items, bucket in (("issue", issues, "issues"), ("pr", prs, "prs")):
        stats = {"source": len(items), "created": 0, "skipped": 0, "updated": 0, "failed": 0}
        for item in items:
            try:
                result = sync_one(
                    cfg["org"],
                    cfg,
                    kind,
                    item,
                    repository=repository,
                    apply=apply,
                    label_ids=label_ids,
                    days_to_finish=days_to_finish(),
                    create_closed=state == "all",
                    client=client,
                )
                if result.startswith("dry-run"):
                    stats["skipped"] += 1
                elif result == "created":
                    stats["created"] += 1
                elif result == "updated-status":
                    stats["updated"] += 1
                else:
                    stats["skipped"] += 1
            except (YunxiaoApiError, PreflightError, OSError) as error:
                stats["failed"] += 1
                print(f"failed {kind} #{item.get('number')}: {error}", file=sys.stderr)
            time.sleep(0.12)
        summary[bucket] = stats

    print(json.dumps(summary, ensure_ascii=False))
    return 0 if all(stats["failed"] == 0 for stats in summary.values()) else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GitHub → 云效同步")
    parser.add_argument("--mode", choices=("preflight", "event", "backfill"), default="preflight")
    parser.add_argument("--state", choices=("open", "all"), default="open")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("YUNXIAO_TOKEN", "").strip()
    if not token:
        print("缺少 YUNXIAO_TOKEN", file=sys.stderr)
        return 2

    client = YunxiaoClient(
        UrllibTransport(
            token,
            base_url=(
                os.environ.get("YUNXIAO_API_BASE_URL", "").strip()
                or "https://openapi-rdc.aliyuncs.com"
            ),
        )
    )

    try:
        if args.mode == "event":
            return handle_event(client)
        if args.mode == "backfill":
            return backfill(client, apply=args.apply and not args.dry_run, state=args.state)

        result = configuration_from_environment(client)
        print(
            json.dumps(
                {
                    "org": result["org"],
                    "project_id": result["project_id"],
                    "parent_id": result["parent_id"],
                    "sprint_id": result["sprint_id"],
                    "participant_ids": result["participant_ids"],
                    "workitem_category": result["workitem_category"],
                    "type_id": result["type_id"],
                    "type_name": result["type_name"],
                    "assignee_id": result["assignee_id"],
                    "priority_id": result["priority_id"],
                    "statuses": result["statuses"],
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 0
    except (PreflightError, YunxiaoApiError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
