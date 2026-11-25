// Terraform 리소스(plan의 after 값 또는 .tf에서 읽은 리터럴 값)를 공통 항목표의 항목으로 바꾼다.
// 비용을 만드는 리소스와, 비용은 없지만 판정에 필요한 리소스(launch template, autoscaling target 등)를 함께 다룬다.
// 값을 모르면(plan의 unknown, .tf의 변수 참조) null로 둔다. 지어내지 않는다.

// 환경 이름. 영문은 단어 경계로만 찾는다("product"가 prod로 잡히지 않게).
const PROD_WORDS = ["prod", "prd", "production", "live", "운영", "상용"];
const NONPROD_WORDS = ["nonprod", "dev", "develop", "development", "test", "tst", "qa", "uat", "stg", "stage", "staging", "sandbox", "sbx", "demo", "poc", "개발", "테스트", "검증", "스테이징"];
// "비운영", "non-prod", "pre-prod"는 운영 단어를 품고 있지만 비운영이다
const NEGATED = /비\s*운영|non[\s_-]?prod(uction)?|pre[\s_-]?prod(uction)?/i;
const wordRe = (w) => (/^[a-z]/.test(w) ? new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, "i") : new RegExp(w));

function envOfSegment(t) {
  if (NEGATED.test(t)) return { env: "nonprod", env_class: "nonprod" };
  // 운영·비운영 단어가 함께 있으면 앞에 나온 쪽("개발(운영 미러)" → 개발)
  let best = null;
  for (const [cls, words] of [["prod", PROD_WORDS], ["nonprod", NONPROD_WORDS]]) {
    for (const w of words) {
      const m = wordRe(w).exec(t);
      if (m && (!best || m.index < best.at)) best = { at: m.index, env: cls === "prod" ? "prod" : w, env_class: cls };
    }
  }
  return best ? { env: best.env, env_class: best.env_class } : { env: null, env_class: "unknown" };
}

// 경로는 뒤쪽 조각을 먼저 본다("infrastructure-live/dev/plan.json" → dev)
export function envOf(...texts) {
  const segs = texts.filter(Boolean).join("/").toLowerCase().split(/[\\/]|::/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const e = envOfSegment(segs[i]);
    if (e.env_class !== "unknown") return e;
  }
  return { env: null, env_class: "unknown" };
}

export function envClassOf(label) {
  return label ? envOf(String(label)).env_class : "unknown";
}

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? undefined;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const str = (v) => (typeof v === "string" ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null);
// 속성이 아예 없으면 provider 기본값(false), 변수 등으로 정해져 모르면 null
const flag = (v) => (v === undefined ? false : bool(v));
const isExpr = (v) => Boolean(v && typeof v === "object" && "__expr" in v); // .tf에서 리터럴이 아닌 값

// 비용이 생기는 범주. 나머지(template, scaling, lifecycle 등)는 판정 보조용이다.
export const COST_CATEGORIES = new Set(["compute", "db", "cache", "nat", "public_ip", "lb", "storage", "log", "object_storage", "managed", "serverless", "search", "queue", "vpn", "cdn", "vpc_endpoint"]);

const MAP = {
  aws_instance: (v) => ({ category: "compute", spec: { type: str(v.instance_type) }, qty: 1, attrs: { root_volume_type: str(first(v.root_block_device)?.volume_type) } }),
  aws_launch_template: (v) => ({ category: "compute_template", spec: { type: str(v.instance_type) }, qty: 0 }),
  aws_launch_configuration: (v) => ({ category: "compute_template", spec: { type: str(v.instance_type) }, qty: 0 }),
  aws_autoscaling_group: (v) => ({ category: "compute", qty: num(v.desired_capacity) ?? num(v.min_size), elastic: { min: num(v.min_size), normal: num(v.desired_capacity), max: num(v.max_size) } }),
  aws_eks_node_group: (v) => {
    const s = first(v.scaling_config) ?? {};
    return { category: "compute", spec: { type: str(first(v.instance_types)) }, qty: num(s.desired_size), elastic: { min: num(s.min_size), normal: num(s.desired_size), max: num(s.max_size) }, attrs: { capacity_type: str(v.capacity_type) } };
  },
  aws_eks_cluster: () => ({ category: "managed", name_hint: "EKS 컨트롤 플레인", qty: 1 }),
  aws_ecs_service: (v) => ({ category: "compute", qty: num(v.desired_count), attrs: { launch_type: str(v.launch_type) } }),
  aws_autoscaling_schedule: (v) => ({ category: "schedule", qty: 0, elastic: { min: num(v.min_size), max: num(v.max_size) }, attrs: { recurrence: str(v.recurrence) } }),
  aws_appautoscaling_scheduled_action: () => ({ category: "schedule", qty: 0 }),
  aws_appautoscaling_target: (v) => ({ category: "scaling", qty: 0, elastic: { min: num(v.min_capacity), max: num(v.max_capacity) }, attrs: { resource_id: str(v.resource_id) } }),
  aws_db_instance: (v) => ({
    category: "db",
    spec: { type: str(v.instance_class), disk_gb: num(v.allocated_storage), storage_type: str(v.storage_type) },
    qty: 1,
    ha: { multi_az: flag(v.multi_az), replica: Boolean(v.replicate_source_db) },
    attrs: { engine: str(v.engine) },
  }),
  aws_rds_cluster: (v) => {
    const s = first(v.serverlessv2_scaling_configuration);
    return { category: "db_cluster", qty: 0, attrs: { engine: str(v.engine), engine_mode: str(v.engine_mode) }, elastic: s ? { min: num(s.min_capacity), max: num(s.max_capacity) } : null };
  },
  aws_rds_cluster_instance: (v) => ({ category: "db", spec: { type: str(v.instance_class) }, qty: 1 }),
  aws_elasticache_replication_group: (v) => {
    const n = num(v.num_cache_clusters) ?? (num(v.num_node_groups) != null ? num(v.num_node_groups) * (1 + (num(v.replicas_per_node_group) ?? 0)) : null);
    return { category: "cache", spec: { type: str(v.node_type) }, qty: n, ha: { multi_az: flag(v.multi_az_enabled), replicas: n != null ? n - 1 : null } };
  },
  aws_elasticache_cluster: (v) => ({ category: "cache", spec: { type: str(v.node_type) }, qty: num(v.num_cache_nodes) ?? 1 }),
  aws_nat_gateway: (v) => ({ category: "nat", qty: 1, attrs: { connectivity_type: str(v.connectivity_type) ?? "public" } }),
  aws_eip: () => ({ category: "public_ip", qty: 1 }),
  aws_lb: (v) => ({ category: "lb", qty: 1, attrs: { internal: bool(v.internal), lb_type: str(v.load_balancer_type) ?? "application" } }),
  aws_alb: (v) => ({ category: "lb", qty: 1, attrs: { internal: bool(v.internal), lb_type: "application" } }),
  aws_elb: (v) => ({ category: "lb", qty: 1, attrs: { internal: bool(v.internal), lb_type: "classic" } }),
  aws_ebs_volume: (v) => ({ category: "storage", spec: { storage_type: str(v.type), disk_gb: num(v.size) }, qty: 1 }),
  aws_cloudwatch_log_group: (v) => ({ category: "log", qty: 1, attrs: { retention_in_days: num(v.retention_in_days) ?? (isExpr(v.retention_in_days) ? "unknown" : null) } }),
  aws_s3_bucket: () => ({ category: "object_storage", qty: 1 }),
  aws_s3_bucket_lifecycle_configuration: () => ({ category: "lifecycle", qty: 0 }),
  aws_vpc_endpoint: (v) => {
    const t = str(v.vpc_endpoint_type) ?? "Gateway";
    return { category: t === "Gateway" ? "vpc_endpoint_free" : "vpc_endpoint", qty: 1, attrs: { service_name: str(v.service_name) ?? (isExpr(v.service_name) ? v.service_name.__expr : null), endpoint_type: t } }; // 변수가 섞인 이름도 서비스 부분(.s3)은 남긴다
  },
  aws_lambda_function: (v) => ({ category: "serverless", qty: 1, attrs: { memory_size: num(v.memory_size), architectures: v.architectures ?? null } }),
  aws_dynamodb_table: (v) => ({ category: "db", qty: 1, attrs: { billing_mode: str(v.billing_mode) ?? "PROVISIONED" } }),
  aws_opensearch_domain: (v) => {
    const c = first(v.cluster_config) ?? {};
    return { category: "search", spec: { type: str(c.instance_type) }, qty: num(c.instance_count) ?? 1, ha: { multi_az: flag(c.zone_awareness_enabled) } };
  },
  aws_msk_cluster: (v) => ({ category: "queue", spec: { type: str(first(v.broker_node_group_info)?.instance_type) }, qty: num(v.number_of_broker_nodes) }),
  aws_vpn_connection: () => ({ category: "vpn", qty: 1 }),
  aws_cloudfront_distribution: () => ({ category: "cdn", qty: 1 }),
};

export const SUPPORTED_TYPES = Object.keys(MAP);

// r: { address, type, values, refs?: string[], module?: string }
export function toItem(r, opts = {}) {
  const fn = MAP[r.type];
  if (!fn) return null;
  const m = fn(r.values ?? {});
  // tags에 없으면 tags_all(provider default_tags 포함)에서 찾는다. 키 대소문자는 가리지 않는다
  const envTag = (t) => {
    if (!t || typeof t !== "object" || isExpr(t)) return null;
    const k = Object.keys(t).find((key) => /^(environment|env|stage)$/i.test(key));
    return k ? str(t[k]) : null;
  };
  const tagEnv = envTag(r.values?.tags) ?? envTag(r.values?.tags_all);
  // 태그 → 주소(모듈 이름) → 파일 경로 순으로, 먼저 판정되는 것을 쓴다
  const e = opts.env
    ? { env: opts.env, env_class: envClassOf(opts.env) }
    : [str(tagEnv), r.address, opts.pathHint].map((t) => envOf(t)).find((x) => x.env_class !== "unknown") ?? { env: null, env_class: "unknown" };
  return {
    id: r.address,
    env: e.env,
    env_class: e.env_class,
    category: m.category,
    type: r.type,
    name: m.name_hint ?? r.address,
    spec: m.spec ?? {},
    qty: m.qty ?? null,
    elastic: m.elastic ?? null,
    ha: m.ha ?? null,
    attrs: m.attrs ?? {},
    refs: r.refs ?? [],
    source: "terraform",
    source_ref: r.source_ref ?? r.address,
    extracted_by: "script",
    confirmed: true,
  };
}

// 리소스끼리 참조로 이어 붙인다: ASG ← launch template 규격, ECS service ← autoscaling target 범위, cluster instance ← serverless v2 범위
export function link(items) {
  const byAddr = new Map(items.map((i) => [i.id.replace(/\[[^\]]*\]$/, ""), i]));
  const find = (ref) => byAddr.get(ref) ?? byAddr.get(ref.replace(/\[[^\]]*\]$/, ""));
  for (const it of items) {
    if (it.type === "aws_autoscaling_group" && !it.spec.type) {
      for (const ref of it.refs) {
        const t = find(ref);
        if (t?.category === "compute_template" && t.spec.type) it.spec.type = t.spec.type;
      }
    }
    if (it.type === "aws_appautoscaling_target") {
      for (const ref of it.refs) {
        const svc = find(ref);
        if (svc?.type === "aws_ecs_service") svc.elastic = { min: it.elastic.min, normal: svc.qty, max: it.elastic.max };
      }
    }
    if (it.type === "aws_rds_cluster_instance") {
      for (const ref of it.refs) {
        const c = find(ref);
        if (c?.type === "aws_rds_cluster") {
          it.attrs.cluster = c.id;
          if (c.elastic) it.elastic = c.elastic;
        }
      }
    }
  }
  // 같은 클러스터의 인스턴스가 2개 이상이면 이중화로 본다
  // 인스턴스 수는 qty를 더한다(count = 2인 리소스 하나도 2대). 모르는 count가 있으면 이중화 여부도 모름
  const perCluster = new Map();
  for (const it of items) if (it.attrs?.cluster) perCluster.set(it.attrs.cluster, (perCluster.get(it.attrs.cluster) ?? 0) + (typeof it.qty === "number" ? it.qty : NaN));
  for (const it of items) {
    if (!it.attrs?.cluster) continue;
    const n = perCluster.get(it.attrs.cluster);
    it.ha = Number.isNaN(n) ? { multi_az: null, replicas: null } : { multi_az: n > 1, replicas: n - 1 };
  }
  return items;
}
