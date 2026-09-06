package com.example;

// Fixture for the CI java smoke check (scripts/ci-java-smoke.mjs). Small on
// purpose: one endpoint, one call, one mapper binding — enough to prove the
// adapter compiles, runs and emits cascade:javafacts:1 records.
@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{id}")
    public String find(@PathVariable String id) {
        return orderService.find(id);
    }
}
