{{/*
Deep-merge `overrides` into the `target` map in place. Unlike Sprig's merge functions, an override
of false, 0, or "" still replaces the target value.
*/}}
{{- define "stack.mergeInto" -}}
{{- $target := .target -}}
{{- range $key, $value := .overrides -}}
{{- $current := get $target $key -}}
{{- if and (kindIs "map" $value) (kindIs "map" $current) -}}
{{- include "stack.mergeInto" (dict "target" $current "overrides" $value) -}}
{{- else -}}
{{- $_ := set $target $key $value -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/* One entry under `services`, merged over `serviceDefaults`, as YAML; read it back with fromYaml. */}}
{{- define "stack.service" -}}
{{- $service := deepCopy .root.Values.serviceDefaults -}}
{{- include "stack.mergeInto" (dict "target" $service "overrides" (get .root.Values.services .name | default dict)) -}}
{{- toYaml $service -}}
{{- end }}

{{/* Selector labels; Deployment selectors are immutable, so `app` stays as originally deployed. */}}
{{- define "stack.selectorLabels" -}}
app: {{ .name }}
{{- end }}

{{/* Labels applied to every resource of one service. */}}
{{- define "stack.labels" -}}
{{ include "stack.selectorLabels" . }}
app.kubernetes.io/name: {{ .name }}
{{ include "stack.commonLabels" .root }}
{{- end }}

{{/* Labels identifying the release, for resources that belong to no single service. */}}
{{- define "stack.commonLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/*
A container's `image` and `imagePullPolicy`. An image built here is `<registry>/<image>:<tag>` from
the global registry, tag, and pull policy and the service's image name; an empty tag selects the
chart's appVersion. An upstream image is a full reference used as is, pulled when the node lacks it.
*/}}
{{- define "stack.containerImage" -}}
{{- if and .image .upstreamImage -}}
{{- fail (printf "services.%s sets both image and upstreamImage" .name) -}}
{{- else if .upstreamImage -}}
image: {{ .upstreamImage }}
imagePullPolicy: IfNotPresent
{{- else -}}
{{- $image := required (printf "services.%s needs image or upstreamImage" .name) .image -}}
image: {{ with .root.Values.global.image.registry }}{{ trimSuffix "/" . }}/{{ end }}{{ $image }}:{{ .root.Values.global.image.tag | default .root.Chart.AppVersion }}
imagePullPolicy: {{ .root.Values.global.image.pullPolicy }}
{{- end }}
{{- end }}

{{/*
A container in a service's pod beside its main one, from an entry under `initContainers`, which runs
to completion before the others start, or `sidecars`, which runs for the pod's whole life. It uses the
service's container security context unless it sets its own, and mounts the service's volumes by name.
*/}}
{{- define "stack.extraContainer" -}}
{{- $root := .root -}}
{{- $container := .container -}}
{{- $sidecar := eq .kind "sidecars" -}}
- name: {{ .containerName }}
  {{- include "stack.containerImage" (dict "root" $root "name" (printf "%s.%s.%s" .name .kind .containerName) "image" $container.image "upstreamImage" $container.upstreamImage) | nindent 2 }}
  {{- if $sidecar }}
  restartPolicy: Always
  {{- end }}
  {{- with $container.command }}
  command:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $container.args }}
  args:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    {{- toYaml ($container.containerSecurityContext | default .service.containerSecurityContext) | nindent 4 }}
  {{- with $container.env }}
  env:
    {{- include "stack.env" (dict "root" $root "env" .) | trim | nindent 4 }}
  {{- end }}
  {{- if $sidecar }}
  {{- range $probe, $spec := $container.probes }}
  {{ $probe }}Probe:
    {{- toYaml $spec | nindent 4 }}
  {{- end }}
  {{- end }}
  {{- with $container.resources }}
  resources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $container.volumeMounts }}
  volumeMounts:
    {{- range $volumeName, $mountPath := . }}
    {{- if not (hasKey $.service.volumes $volumeName) }}
    {{- fail (printf "services.%s.%s.%s mounts volume %q, which the service does not declare" $.name $.kind $.containerName $volumeName) }}
    {{- end }}
    - name: {{ $volumeName }}
      mountPath: {{ $mountPath }}
    {{- end }}
  {{- end }}
{{- end }}

{{/*
The URL at which other pods reach a service's exposed port, as `<scheme>://<service>.<namespace>
.svc.cluster.local:<servicePort><path>`; empty when the service is turned off or absent, which a
client setting built from it reads as no service.
*/}}
{{- define "stack.serviceUrl" -}}
{{- $service := include "stack.service" (dict "root" .root "name" .name) | fromYaml -}}
{{- if and (hasKey .root.Values.services .name) $service.enabled -}}
{{- $port := required (printf "services.%s has no port %q" .name .port) (get $service.ports .port) -}}
{{- $servicePort := required (printf "services.%s.ports.%s has no servicePort" .name .port) $port.servicePort -}}
{{ .scheme }}://{{ .name }}.{{ .root.Release.Namespace }}.svc.cluster.local:{{ $servicePort }}{{ .path }}
{{- end -}}
{{- end }}

{{/*
A container's `env` list from a map of variable name to a literal value, rendered as a template, or
to `{ secretName, key }` for a Secret value.
*/}}
{{- define "stack.env" -}}
{{- range $variable, $value := .env }}
- name: {{ $variable }}
  {{- if kindIs "map" $value }}
  valueFrom:
    secretKeyRef:
      name: {{ tpl $value.secretName $.root }}
      key: {{ $value.key }}
  {{- else }}
  value: {{ tpl (toString $value) $.root | quote }}
  {{- end }}
{{- end }}
{{- end }}

{{/* Claim name for a service's persistent volume: `<service>-<volume>`. */}}
{{- define "stack.claimName" -}}
{{ printf "%s-%s" .name .volumeName }}
{{- end }}

{{/* ConfigMap holding a service's `files` volume. */}}
{{- define "stack.configMapName" -}}
{{ printf "%s-%s" .name .volumeName }}
{{- end }}

{{/* Claim name of a shared volume, failing when the service references an undeclared one. */}}
{{- define "stack.sharedClaimName" -}}
{{- if not (hasKey .root.Values.sharedVolumes .sharedVolume) -}}
{{- fail (printf "services.%s mounts shared volume %q, which is not declared in sharedVolumes" .service .sharedVolume) -}}
{{- end -}}
{{ .sharedVolume }}
{{- end }}

{{/* Claim spec for requested storage, defaulting the storage class to the global one. */}}
{{- define "stack.claimSpec" -}}
accessModes:
  {{- toYaml (.volume.accessModes | default .defaultAccessModes) | nindent 2 }}
{{- with (.volume.storageClassName | default .root.Values.global.storageClassName) }}
storageClassName: {{ . }}
{{- end }}
resources:
  requests:
    storage: {{ .volume.size }}
{{- end }}

{{/* Parse a JSON file packaged with the chart, as JSON text; read it back with fromJson. */}}
{{- define "stack.readJson" -}}
{{- $parsed := .root.Files.Get .path | fromJson -}}
{{- if or (not $parsed) (hasKey $parsed "Error") -}}
{{- fail (printf "%s is missing or is not valid JSON" .path) -}}
{{- end -}}
{{- toJson $parsed -}}
{{- end }}

{{/*
Rules a service with `releaseAccess` needs to manage the release's own resources with Helm, as YAML
lists: every kind the chart's templates render, and Helm's release records, which are Secrets in the
release's namespace. Claims and namespaces are kept on uninstall, so they are never deleted. Keep the
kinds in step with the templates; the upgrader's tests check that they cover the rendered chart.
*/}}
{{- define "stack.releaseNamespaceRules" -}}
- apiGroups: [apps]
  resources: [deployments, statefulsets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [""]
  resources: [services, secrets, configmaps, serviceaccounts]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [""]
  resources: [persistentvolumeclaims]
  verbs: [get, list, watch, create, update, patch]
- apiGroups: [networking.k8s.io]
  resources: [ingresses]
  verbs: [get, list, watch, create, update, patch, delete]
# Helm waits for workloads to become ready through their replica sets and pods.
- apiGroups: [apps]
  resources: [replicasets]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [pods]
  verbs: [get, list, watch]
{{- end }}

{{/*
What the chart renders in every namespace it gives services access to or creates for their workloads:
Roles and RoleBindings, and Secrets such as the registry's push and pull credentials.
*/}}
{{- define "stack.workloadNamespaceRules" -}}
- apiGroups: [rbac.authorization.k8s.io]
  resources: [roles, rolebindings]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [""]
  resources: [secrets]
  verbs: [get, list, watch, create, update, patch, delete]
{{- end }}

{{/* The cluster-scoped kinds the chart renders. */}}
{{- define "stack.clusterManagementRules" -}}
- apiGroups: [""]
  resources: [namespaces]
  verbs: [get, list, watch, create, update, patch]
- apiGroups: [rbac.authorization.k8s.io]
  resources: [clusterroles, clusterrolebindings]
  verbs: [get, list, watch, create, update, patch, delete]
{{- end }}
