package com.example;
@RestController
@RequestMapping("/smoke")
public class SmokeController {
    private final SmokeMapper mapper;
    public SmokeController(SmokeMapper mapper) { this.mapper = mapper; }
    @GetMapping("/{id}")
    public String find(String id) { return mapper.find(id); }
}
