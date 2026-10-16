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
Image reference `<registry>/<image>:<tag>` from the global registry and tag and the service's image
name. An empty tag selects the chart's appVersion.
*/}}
{{- define "stack.image" -}}
{{- $image := required (printf "services.%s.image is required" .name) .image -}}
{{- with .root.Values.global.image.registry }}{{ trimSuffix "/" . }}/{{ end }}{{ $image }}:{{ .root.Values.global.image.tag | default .root.Chart.AppVersion }}
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
