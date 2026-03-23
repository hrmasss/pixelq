package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/pixelq/app/internal/client"
	"github.com/pixelq/app/internal/scheduler"
	"github.com/pixelq/app/internal/storage"
)

type MCPRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type MCPResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *MCPError   `json:"error,omitempty"`
}

type MCPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func runMCP() {
	log.SetOutput(os.Stderr)

	apiClient := client.New()
	if _, err := apiClient.Status(); err != nil {
		log.Fatalf("PixelQ daemon is not running: %v", err)
	}

	reader := bufio.NewReader(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}

		var req MCPRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		resp := handleMCPRequest(req, apiClient)
		if resp != nil {
			_ = encoder.Encode(resp)
		}
	}
}

func handleMCPRequest(req MCPRequest, apiClient *client.Client) *MCPResponse {
	switch req.Method {
	case "initialize":
		return &MCPResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
				"serverInfo":      map[string]interface{}{"name": "pixelq", "version": AppReleaseVersion},
			},
		}
	case "notifications/initialized":
		return nil
	case "tools/list":
		return &MCPResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{"tools": getMCPTools()},
		}
	case "tools/call":
		return handleToolCall(req, apiClient)
	default:
		return &MCPResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &MCPError{Code: -32601, Message: "Method not found"},
		}
	}
}

func getMCPTools() []map[string]interface{} {
	return []map[string]interface{}{
		tool("queue_job", "Queue a single image generation job", map[string]interface{}{
			"prompt": map[string]interface{}{"type": "string"},
		}, []string{"prompt"}),
		tool("queue_batch", "Queue multiple image generation jobs", map[string]interface{}{
			"jobs": map[string]interface{}{
				"type": "array",
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"prompt":   map[string]interface{}{"type": "string"},
						"priority": map[string]interface{}{"type": "integer"},
					},
					"required": []string{"prompt"},
				},
			},
		}, []string{"jobs"}),
		tool("list_jobs", "List queued and historical jobs", map[string]interface{}{}, nil),
		tool("get_status", "Get service, queue, and bridge status", map[string]interface{}{}, nil),
		tool("list_templates", "List saved templates", map[string]interface{}{}, nil),
		tool("queue_template_runs", "Resolve a template with run values and queue the jobs", map[string]interface{}{
			"templateId": map[string]interface{}{"type": "string"},
			"runs": map[string]interface{}{
				"type": "array",
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"values": map[string]interface{}{
							"type":                 "object",
							"additionalProperties": map[string]interface{}{"type": "string"},
						},
					},
				},
			},
			"project": map[string]interface{}{"type": "string"},
		}, []string{"templateId", "runs"}),
		tool("search_catalog", "Search the managed image catalog", map[string]interface{}{
			"query": map[string]interface{}{"type": "string"},
			"limit": map[string]interface{}{"type": "integer"},
		}, nil),
		tool("get_asset_details", "Get details for one catalog asset", map[string]interface{}{
			"id": map[string]interface{}{"type": "string"},
		}, []string{"id"}),
	}
}

func handleToolCall(req MCPRequest, apiClient *client.Client) *MCPResponse {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	_ = json.Unmarshal(req.Params, &params)

	var (
		result interface{}
		err    error
	)

	switch params.Name {
	case "queue_job":
		var args struct {
			Prompt string `json:"prompt"`
		}
		_ = json.Unmarshal(params.Arguments, &args)
		result, err = apiClient.QueueJob(args.Prompt, 0, nil)
	case "queue_batch":
		var args struct {
			Jobs []scheduler.JobInput `json:"jobs"`
		}
		_ = json.Unmarshal(params.Arguments, &args)
		result, err = apiClient.QueueBatch(args.Jobs)
	case "list_jobs":
		result, err = apiClient.ListJobs(100)
	case "get_status":
		result, err = apiClient.Status()
	case "list_templates":
		result, err = apiClient.ListTemplates()
	case "queue_template_runs":
		var args struct {
			TemplateID string                `json:"templateId"`
			Runs       []storage.TemplateRun `json:"runs"`
			Project    string                `json:"project"`
		}
		_ = json.Unmarshal(params.Arguments, &args)
		result, err = apiClient.QueueTemplateRuns(args.TemplateID, args.Runs, args.Project)
	case "search_catalog":
		var args struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		_ = json.Unmarshal(params.Arguments, &args)
		result, err = apiClient.ListAssets(args.Query, args.Limit)
	case "get_asset_details":
		var args struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(params.Arguments, &args)
		result, err = apiClient.GetAsset(args.ID)
	default:
		err = fmt.Errorf("unknown tool: %s", params.Name)
	}

	if err != nil {
		return &MCPResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &MCPError{Code: -32602, Message: err.Error()},
		}
	}

	content, _ := json.MarshalIndent(result, "", "  ")
	return &MCPResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]interface{}{
			"content": []map[string]interface{}{{"type": "text", "text": string(content)}},
		},
	}
}

func tool(name, description string, properties map[string]interface{}, required []string) map[string]interface{} {
	schema := map[string]interface{}{
		"type":       "object",
		"properties": properties,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return map[string]interface{}{
		"name":        name,
		"description": description,
		"inputSchema": schema,
	}
}
