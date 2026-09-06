package com.example;

@Service
public class OrderService {

    private final OrderMapper orderMapper;

    // The Spring Data repository declared in OrderEntity.java. It is here so the
    // fixture carries ONE chain that runs the whole way: endpoint -> handler ->
    // service -> repository method -> the @Query's statement -> the column it
    // reads. Without it a column-impact answer over this fixture is empty for a
    // structural reason rather than a wrong one.
    private final OrderEntityRepository orderRepository;

    public OrderService(OrderMapper orderMapper, OrderEntityRepository orderRepository) {
        this.orderMapper = orderMapper;
        this.orderRepository = orderRepository;
    }

    public String find(String id) {
        orderRepository.statusOf(id);
        return orderMapper.selectById(id);
    }
}
